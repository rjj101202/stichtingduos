// Lokaal draaien: npm start
const app = require('./app');
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Stichting DUOS website draait op http://localhost:${PORT}`);
  console.log(`Beheer: http://localhost:${PORT}/admin`);
});
