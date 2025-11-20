const mongoose = require("mongoose");

const TrashSchema = new mongoose.Schema({
  version: String,
  filename: String,
  notes: String,
  deletedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Trash", TrashSchema);
