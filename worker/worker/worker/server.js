import express from "express";
import { runJob } from "./transcode.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_, res) => res.json({ ok: true, service: "Obaid Tube Worker" }));

app.post("/jobs/transcode", async (req, res) => {
  try {
    const { videoId, sourceKey } = req.body || {};
    if (!videoId || !sourceKey) {
      return res.status(400).json({ error: "videoId and sourceKey are required" });
    }
    const result = await runJob({ videoId, sourceKey });
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Transcoding failed" });
  }
});

app.listen(8080);
