const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || '');
    cb(null, unique + ext);
  },
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const DB_NAME = process.env.DB_NAME || 'local_farmer_market';
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASS || '';
const DB_PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306;

let pool;

async function initDatabase() {
  const serverConn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    port: DB_PORT,
    multipleStatements: true,
  });
  await serverConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
  await serverConn.end();

  pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    port: DB_PORT,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  const conn = await pool.getConnection();
  try {
    await conn.query(`
      DROP TABLE IF EXISTS orders;
    `);
    await conn.query(`
      DROP TABLE IF EXISTS products;
    `);
    await conn.query(`
      DROP TABLE IF EXISTS users;
    `);
    await conn.query(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('farmer', 'customer') NOT NULL
      )
    `);
    await conn.query(`
      CREATE TABLE products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        quantity INT NOT NULL,
        image_path VARCHAR(255) NULL,
        created_by INT NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await conn.query(`
      CREATE TABLE orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL,
        price_at_purchase DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);

    const saltRounds = 10;
    const farmerHash = await bcrypt.hash('password123', saltRounds);
    const customerHash = await bcrypt.hash('password123', saltRounds);

    const [farmerRes] = await conn.query(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      ['farmer1', farmerHash, 'farmer']
    );
    await conn.query(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      ['customer1', customerHash, 'customer']
    );

    const farmerId = farmerRes.insertId;
    await conn.query(
      'INSERT INTO products (name, price, quantity, image_path, created_by) VALUES ?',
      [[
        ['Organic Tomatoes', 2.99, 50, null, farmerId],
        ['Free-range Eggs (dozen)', 4.50, 30, null, farmerId],
        ['Raw Honey (500g)', 7.99, 20, null, farmerId],
        ['Baby Spinach (250g)', 1.99, 40, null, farmerId]
      ]]
    );
    console.log('Database initialized with default users and products');
  } finally {
    conn.release();
  }
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.session.user.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
  if (!rows || rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/products', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
  res.json({ products: rows });
});

app.post('/api/purchase', requireRole('customer'), async (req, res) => {
  const { productId, quantity } = req.body || {};
  const qty = Number(quantity);
  const pid = Number(productId);
  if (!pid || !qty || qty <= 0) return res.status(400).json({ error: 'Invalid input' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM products WHERE id = ? FOR UPDATE', [pid]);
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Product not found' });
    }
    const product = rows[0];
    if (product.quantity < qty) {
      await conn.rollback();
      return res.status(400).json({ error: 'Insufficient stock' });
    }
    const newQty = product.quantity - qty;
    await conn.query('UPDATE products SET quantity = ? WHERE id = ?', [newQty, pid]);
    await conn.query(
      'INSERT INTO orders (user_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
      [req.session.user.id, pid, qty, product.price]
    );
    await conn.commit();
    res.json({ success: true, remaining: newQty });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Purchase failed' });
  } finally {
    conn.release();
  }
});

app.post('/api/checkout', requireRole('customer'), async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const lines = [];
    for (const it of items) {
      const pid = Number(it.productId);
      const qty = Number(it.quantity);
      if (!pid || !qty || qty <= 0) {
        await conn.rollback();
        return res.status(400).json({ error: 'Invalid cart item' });
      }
      const [rows] = await conn.query('SELECT * FROM products WHERE id = ? FOR UPDATE', [pid]);
      if (rows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: `Product ${pid} not found` });
      }
      const product = rows[0];
      if (product.quantity < qty) {
        await conn.rollback();
        return res.status(400).json({ error: `Insufficient stock for ${product.name}` });
      }
      const newQty = product.quantity - qty;
      await conn.query('UPDATE products SET quantity = ? WHERE id = ?', [newQty, pid]);
      await conn.query(
        'INSERT INTO orders (user_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
        [req.session.user.id, pid, qty, product.price]
      );
      const lineTotal = Number(product.price) * qty;
      lines.push({
        productId: pid,
        name: product.name,
        quantity: qty,
        price: Number(product.price),
        lineTotal,
        remaining: newQty,
      });
    }
    await conn.commit();
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    res.json({ success: true, total, lines });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Checkout failed' });
  } finally {
    conn.release();
  }
});

app.post('/api/sell', requireRole('farmer'), upload.single('image'), async (req, res) => {
  const { name, price, quantity } = req.body || {};
  const file = req.file || null;
  const imgPath = file ? `/uploads/${file.filename}` : null;
  const p = Number(price);
  const q = Number(quantity);
  if (!name || !p || p <= 0 || !q || q <= 0) return res.status(400).json({ error: 'Invalid input' });
  await pool.query(
    'INSERT INTO products (name, price, quantity, image_path, created_by) VALUES (?, ?, ?, ?, ?)',
    [name, p, q, imgPath, req.session.user.id]
  );
  res.json({ success: true });
});

app.get('/', (req, res) => res.redirect('/home'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/buy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'buy.html')));
app.get('/sell', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sell.html')));

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`Local Farmer Market running at http://localhost:${PORT}/`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
