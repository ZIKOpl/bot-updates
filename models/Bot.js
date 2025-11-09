const mongoose = require("mongoose");

const botSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ownerId: { type: String, required: true },
  token: { type: String, required: true }, // 🔒 Token chiffré
  meta: {
    notes: String,
  },
  stats: {
    lastReady: Date,
    lastCheck: Date,
    restarts: { type: Number, default: 0 },
    errors: { type: Number, default: 0 },
  },
}, { timestamps: true });

module.exports = mongoose.model("Bot", botSchema);
