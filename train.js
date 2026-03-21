const fs = require("fs");
const csv = require("csv-parser");
const { RandomForestRegression } = require("ml-random-forest");

// --- Helper: convert node_id ---
function getNumericNodeId(nodeId) {
  if (!nodeId) return 0;
  return parseInt(nodeId.toString().replace("node_", ""));
}

// Read CSV
function loadCSV(filePath) {
  return new Promise((resolve) => {
    const data = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => data.push(row))
      .on("end", () => resolve(data));
  });
}

(async () => {
  const rows = await loadCSV("pineapple_yield_data_2nodes_parallel.csv");

  const X = [];
  const y = [];

  const startDate = new Date(rows[0].created_at);

  rows.forEach((r, index) => {
    try {
      const t = new Date(r.created_at);

      const daysSinceStart =
        (t - startDate) / (1000 * 60 * 60 * 24);

      const week = t.getUTCDate();

      const sin = Math.sin((2 * Math.PI * daysSinceStart) / 30);
      const cos = Math.cos((2 * Math.PI * daysSinceStart) / 30);

      const nodeNumeric = getNumericNodeId(r.node_id);

      const features = [
        parseFloat(r.n),
        parseFloat(r.p),
        parseFloat(r.k),
        daysSinceStart,
        week,
        sin,
        cos,
        nodeNumeric
      ];

      const label = parseFloat(r.prediction);

      // Skip bad rows
      if (
        features.some(v => isNaN(v)) ||
        isNaN(label)
      ) {
        console.warn(`⚠️ Skipping bad row ${index}`);
        return;
      }

      X.push(features);
      y.push(label);

    } catch (err) {
      console.warn(`⚠️ Error parsing row ${index}`, err.message);
    }
  });

  console.log(`✅ Clean rows used: ${X.length}`);

  // --- Model config ---
  const options = {
    seed: 42,
    maxFeatures: 0.8,
    replacement: true,
    nEstimators: 200,
  };

  const rf = new RandomForestRegression(options);

  rf.train(X, y);

  console.log("🌳 Model trained!");

  // Save model
  const modelJSON = rf.toJSON();
  fs.writeFileSync("rf_model.json", JSON.stringify(modelJSON));

  console.log("💾 Model saved as rf_model.json!");
})();