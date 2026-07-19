import express from 'express'
import dotenv from 'dotenv'
import { Pool } from 'pg'
import cors from "cors";
import ExcelJS from 'exceljs';

const app = express()
const port = process.env.PORT || 3210;

dotenv.config()

app.use(express.json());
app.use(cors());

app.get('', (req, res) => {
    res.send("Conectado exitosamente")
})

app.get('/record', async(req, res) => {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    })

    try {
        const queryRes = await pool.query(
            'SELECT date, concept, category, description, value, create_time FROM "record" ORDER BY create_time DESC'
        );
        res.status(200).json(queryRes.rows);
    } catch (e) {
        res.status(500).json(e);
    } finally {
        await pool.end();
    }
})

app.post('/insert', async(req, res) => {
    try {        
        const {date, concept, category, description, value} = req.body
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
        })      
        
        const queryRes = await pool.query('INSERT INTO "record" (date, concept, category, description, value, create_time) VALUES($1, $2, $3, $4, $5, $6) RETURNING id', 
            [date, concept, category, description, value, 'NOW()']);
        
        await pool.end()        
        res.status(200).json({id: queryRes.rows[0].id})
    }catch(e) {
        res.status(500).json(e)
    }
})

app.get('/download', async(req, res) => {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    })

    try {
        const queryRes = await pool.query(
            'SELECT date, concept, category, description, value, create_time FROM "record" ORDER BY create_time DESC'
        );

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('records');

        worksheet.columns = [
            { header: 'date', key: 'date', width: 16 },
            { header: 'concept', key: 'concept', width: 24 },
            { header: 'category', key: 'category', width: 20 },
            { header: 'description', key: 'description', width: 36 },
            { header: 'value', key: 'value', width: 14 },
            { header: 'create_time', key: 'create_time', width: 24 }
        ];

        worksheet.addRows(queryRes.rows);

        const content = await workbook.xlsx.writeBuffer();
        const fileName = `records-${new Date().toISOString().slice(0, 10)}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.status(200).send(Buffer.from(content));
    } catch (e) {
        res.status(500).json(e);
    } finally {
        await pool.end();
    }
})

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
})