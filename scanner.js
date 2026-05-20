import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();

app.get("/", (req, res) => {
  res.send("Cardinal Analytics Scanner Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "active"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Scanner running on port ${PORT}`);
});