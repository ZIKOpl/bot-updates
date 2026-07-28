const mongoose = require("mongoose");

const StatSchema = new mongoose.Schema({
  downloads: { type: Number, default: 0 },
  // ⚠️ Object simple (Mixed) et pas Map : server.js utilise stats.bots[id] = {...}
  // et Object.values(stats.bots), ce qui ne fonctionne pas correctement avec un Map Mongoose.
  bots: {
    type: mongoose.Schema.Types.Mixed,
    // Forme de chaque entrée : { botVersion, lastCheck, startedAt, tag }
    default: {},
  },
});

module.exports = mongoose.model("Stat", StatSchema);

