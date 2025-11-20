const mongoose = require("mongoose");

const TrashSchema = new mongoose.Schema({
  version: { type: String, required: true },
  filename: { type: String, required: true },
  notes: { type: String, default: "" },
  deletedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Trash", TrashSchema);
