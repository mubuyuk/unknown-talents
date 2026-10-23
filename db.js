const mongoose = require("mongoose");

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI saknas. Kopiera .env.example till .env och ange din MongoDB-anslutning.");
    process.exit(1);
  }
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");
  } catch (err) {
    console.error("Kunde inte ansluta till MongoDB. Kontrollera MONGO_URI i .env.");
    console.error(err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
