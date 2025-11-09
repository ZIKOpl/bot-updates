const mongoose = require("mongoose");

const StatSchema = new mongoose.Schema({
  downloads: { type: Number, default: 0 },
  bots: {
    type: Map,
    of: {
      botVersion: String,
      lastCheck: Date,
    },
    default: {},
  },
});

module.exports = mongoose.model("Stat", StatSchema);
