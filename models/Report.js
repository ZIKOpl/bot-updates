const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema({
  botId: { type: mongoose.Schema.Types.ObjectId, ref: "Bot" },
  type: { type: String, enum: ["ready", "restart", "error"], required: true },
  payload: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Report", reportSchema);
