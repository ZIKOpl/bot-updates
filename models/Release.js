const mongoose = require("mongoose");

const ReleaseSchema = new mongoose.Schema({
  version: { type: String, required: true, unique: true },
  filename: { type: String, required: true },
  notes: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Release", ReleaseSchema);
