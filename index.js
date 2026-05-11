const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.hihlt50.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("public-issue-report");
    const usersCollection = db.collection("users");
    const issuesCollection = db.collection("issues");

    app.get("/issues", async (req, res) => {
      const query = {};
      const result = await issuesCollection.find(query).toArray();
      res.send(result);
    });
    app.get("/issues/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await issuesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!result) {
          return res.status(404).send({ message: "Issue not found" });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    });

    app.post("/issues", async (req, res) => {
      const issueInfo = req.body;
      const result = await issuesCollection.insertOne(issueInfo);

      res.send(result);
    });

    //create delete api for delete an issue from issues details page
    app.delete("/issues/:id", async (req, res) => {
      const id = req.params.id;
      const query = {
        _id: new ObjectId(id),
      };

      const result = await issuesCollection.deleteOne(query);

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Public Issue Reporting system server sit is running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
