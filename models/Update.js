const mongoose = require("mongoose");

const updateSchema = new mongoose.Schema({
  version: { type: String, required: true },
  notes: String,
  date: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Update", updateSchema);
