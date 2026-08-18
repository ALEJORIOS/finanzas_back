import { db } from './driver.ts';
import { writeValueSql, schemaInfo } from './schema.ts';

/**
 * Demo data for local development only. Never runs against a real
 * DATABASE_URL, and skips entirely if the table already has rows.
 */

interface Template {
  category: string;
  concept: 'Income' | 'Outcome';
  min: number;
  max: number;
  /** Rough number of occurrences per month. */
  perMonth: number;
  descriptions: string[];
}

const TEMPLATES: Template[] = [
  { category: 'Wage', concept: 'Income', min: 4_200_000, max: 4_800_000, perMonth: 1, descriptions: ['Salario mensual'] },
  { category: 'Other', concept: 'Income', min: 150_000, max: 900_000, perMonth: 0.6, descriptions: ['Freelance', 'Reembolso', 'Venta'] },
  { category: 'Food', concept: 'Outcome', min: 25_000, max: 180_000, perMonth: 9, descriptions: ['Mercado', 'Supermercado', 'Frutas y verduras'] },
  { category: 'Restaurants', concept: 'Outcome', min: 20_000, max: 140_000, perMonth: 5, descriptions: ['Almuerzo', 'Cena', 'Café'] },
  { category: 'Transportation', concept: 'Outcome', min: 8_000, max: 90_000, perMonth: 7, descriptions: ['Gasolina moto', 'Taxi', 'Transporte público'] },
  { category: 'Public Services', concept: 'Outcome', min: 60_000, max: 260_000, perMonth: 3, descriptions: ['Energía', 'Agua', 'Internet'] },
  { category: 'Lease', concept: 'Outcome', min: 1_300_000, max: 1_400_000, perMonth: 1, descriptions: ['Arriendo'] },
  { category: 'Health', concept: 'Outcome', min: 30_000, max: 380_000, perMonth: 1.2, descriptions: ['Farmacia', 'Consulta médica', 'Gimnasio'] },
  { category: 'Entertainment', concept: 'Outcome', min: 15_000, max: 160_000, perMonth: 2.5, descriptions: ['Cine', 'Streaming', 'Concierto'] },
  { category: 'Tech', concept: 'Outcome', min: 40_000, max: 900_000, perMonth: 0.5, descriptions: ['Accesorios', 'Suscripción software'] },
  { category: 'Clothes', concept: 'Outcome', min: 50_000, max: 400_000, perMonth: 0.8, descriptions: ['Ropa', 'Zapatos'] },
  { category: 'Tithe', concept: 'Outcome', min: 420_000, max: 480_000, perMonth: 1, descriptions: ['Diezmo'] },
  { category: 'Travel', concept: 'Outcome', min: 200_000, max: 1_800_000, perMonth: 0.25, descriptions: ['Vuelos', 'Hotel'] },
  { category: 'Pet', concept: 'Outcome', min: 30_000, max: 220_000, perMonth: 1, descriptions: ['Comida perro', 'Veterinario'] },
];

// Deterministic PRNG so repeated seeds produce the same demo dataset.
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

export async function seedDemoData(months = 14): Promise<void> {
  const driver = db();

  const { rows } = await driver.query('SELECT COUNT(*)::int AS count FROM "record"');
  if (Number(rows[0]?.count) > 0) return;

  console.log('[db] seeding demo data…');
  const random = makeRandom(20_260_817);
  const today = new Date();
  const info = schemaInfo();

  const entries: Array<{
    date: string;
    concept: string;
    category: string;
    description: string;
    value: number;
    pending: boolean;
  }> = [];

  for (let monthOffset = months - 1; monthOffset >= 0; monthOffset -= 1) {
    const anchor = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthOffset, 1)
    );
    const daysInMonth = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)
    ).getUTCDate();

    for (const template of TEMPLATES) {
      const whole = Math.floor(template.perMonth);
      const extra = random() < template.perMonth - whole ? 1 : 0;

      for (let i = 0; i < whole + extra; i += 1) {
        const day = Math.min(daysInMonth, 1 + Math.floor(random() * daysInMonth));
        const date = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), day));
        if (date > today) continue;

        // Round to the nearest 100 so amounts read like real currency.
        const raw = template.min + random() * (template.max - template.min);
        entries.push({
          date: date.toISOString().slice(0, 10),
          concept: template.concept,
          category: template.category,
          description: template.descriptions[Math.floor(random() * template.descriptions.length)]!,
          value: Math.round(raw / 100) * 100,
          pending: false,
        });
      }
    }
  }

  // A few upcoming planned expenses so the "pendientes" KPI has something to show.
  for (let i = 1; i <= 3; i += 1) {
    const future = new Date(today.getTime() + i * 5 * 86_400_000);
    entries.push({
      date: future.toISOString().slice(0, 10),
      concept: 'Outcome',
      category: ['Health', 'Tech', 'Travel'][i - 1]!,
      description: ['Control médico', 'Renovación licencia', 'Reserva viaje'][i - 1]!,
      value: [180_000, 320_000, 950_000][i - 1]!,
      pending: true,
    });
  }

  await driver.transaction(async (tx) => {
    for (const entry of entries) {
      const columns = ['date', 'concept', 'category', 'description', 'value', 'create_time'];
      const values = ['$1::date', '$2', '$3', '$4', writeValueSql('$5'), 'NOW()'];
      const params: unknown[] = [
        entry.date,
        entry.concept,
        entry.category,
        entry.description,
        entry.value,
      ];

      if (info.hasPending) {
        columns.push('pending');
        values.push(`$${params.length + 1}`);
        params.push(entry.pending);
      }

      await tx.query(
        `INSERT INTO "record" (${columns.join(', ')}) VALUES (${values.join(', ')})`,
        params
      );
    }

    await tx.query(
      `INSERT INTO "account" (name, kind, color, icon, opening_balance)
       VALUES ($1,$2,$3,$4,$5), ($6,$7,$8,$9,$10), ($11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING`,
      [
        'Efectivo', 'cash', '#22c55e', 'wallet', 200_000,
        'Cuenta de ahorros', 'bank', '#3b82f6', 'bank', 5_000_000,
        'Tarjeta de crédito', 'card', '#a855f7', 'card', 0,
      ]
    );

    const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);

    await tx.query(
      `INSERT INTO "budget" (category, amount, period, start_date, alert_threshold, note)
       VALUES ($1,$2,'monthly',$3::date,80,$4),
              ($5,$6,'monthly',$3::date,75,$7),
              ($8,$9,'monthly',$3::date,80,$10),
              ($11,$12,'monthly',$3::date,90,$13)
       ON CONFLICT DO NOTHING`,
      [
        'Food', 900_000, startOfMonth, 'Mercado y despensa',
        'Restaurants', 400_000, 'Salidas a comer',
        'Transportation', 350_000, 'Gasolina y transporte',
        'Entertainment', 250_000, 'Ocio',
      ]
    );
  });

  console.log(`[db] seeded ${entries.length} demo records`);
}
