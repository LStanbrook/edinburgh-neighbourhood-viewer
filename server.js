const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const PORT = process.env.PORT || 3000;
const CHECKLIST_PATH = path.join(__dirname, "data", "checklist.json");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Writes are serialised through this promise chain so two near-simultaneous
// PATCH requests (e.g. two open tabs) can't interleave a read-modify-write
// and drop one of the updates.
let writeQueue = Promise.resolve();

async function readChecklist() {
  try {
    const raw = await fs.readFile(CHECKLIST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function updateChecklist(mutate) {
  writeQueue = writeQueue.then(async () => {
    const data = await readChecklist();
    const result = mutate(data);
    await fs.writeFile(CHECKLIST_PATH, JSON.stringify(data, null, 2));
    return result;
  });
  return writeQueue;
}

app.get("/api/checklist", async (req, res) => {
  res.json(await readChecklist());
});

app.patch("/api/checklist/:id", async (req, res) => {
  const { id } = req.params;
  const { visited, rating, price, notes } = req.body || {};

  if (rating !== undefined && rating !== null && (rating < 1 || rating > 5)) {
    return res.status(400).json({ error: "rating must be between 1 and 5" });
  }
  if (price !== undefined && price !== null && !["£", "££", "£££", "££££"].includes(price)) {
    return res.status(400).json({ error: "invalid price tier" });
  }

  const entry = await updateChecklist((data) => {
    const existing = data[id] || {};
    const updated = { ...existing };
    if (visited !== undefined) updated.visited = visited;
    if (rating !== undefined) updated.rating = rating;
    if (price !== undefined) updated.price = price;
    if (notes !== undefined) updated.notes = notes;
    updated.updatedAt = new Date().toISOString();

    if (!updated.visited && !updated.rating && !updated.price && !updated.notes) {
      delete data[id];
    } else {
      data[id] = updated;
    }
    return data[id] || {};
  });

  res.json(entry);
});

app.listen(PORT, () => {
  console.log(`Edinburgh Neighbourhood Viewer running at http://localhost:${PORT}`);
});
