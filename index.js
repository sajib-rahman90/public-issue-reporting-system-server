const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Public Issue Reporting system server sit is running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
