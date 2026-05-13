const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const app = express();
const port = process.env.PORT || 3000;

const admin = require("firebase-admin");

const serviceAccount = require("./public-issue-reporting-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(cors());
app.use(express.json());

// JWT token verification imp
const verifyFBToken = async (req, res, next) => {
  // console.log("headers in the middleware", req.headers?.authorization);
  const token = req.headers?.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    // console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized acces" });
  }
};

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

    // User block check api
    const verifyNotBlocked = async (req, res, next) => {
      try {
        const email = req.decoded_email;
        const user = await usersCollection.findOne({
          email: email,
        });

        if (user?.isBlocked) {
          return res.status(403).send({
            message: "You are blocked by admin",
          });
        }

        next();
      } catch (error) {
        return res.status(500).send({
          message: "Blocked verification failed",
        });
      }
    };

    //save or update a user in db
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "citizen";
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: "user allready exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // get a users role
    app.get("/user/role/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send({ role: result?.role });
    });

    app.get("/issues", verifyFBToken, async (req, res) => {
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

    //Dashboards Citizen My issues pages all apis
    // GET MY ISSUES

    app.get("/my-issues", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {
        reporterEmail: email,
      };

      const result = await issuesCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    // UPDATE ISSUE

    app.put("/issues/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const query = {
        _id: new ObjectId(id),
      };

      const updatedDoc = {
        $set: {
          title: updatedData.title,
          category: updatedData.category,
          location: updatedData.location,
          description: updatedData.description,
          image: updatedData.image,
        },
      };

      const result = await issuesCollection.updateOne(query, updatedDoc);

      res.send(result);
    });

    //payment related apis
    app.post("/issues/:id/create-checkout-session", async (req, res) => {
      const { id } = req.params;
      const { email } = req.body;
      const { title } = req.body;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "bdt",
              unit_amount: 100 * 100,
              product_data: {
                name: "Issue Boost",
                description: `Boost issue: ${title}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: email,
        metadata: {
          type: "issue-boost",
          issueId: id,
          email,
        },
        success_url: `${process.env.SITE_DOMAIN}/boost-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/issue/${id}`,
      });
      // console.log(session);
      res.send({ url: session.url });
    });

    //server side confirm payment api check

    app.post("/confirm-boost-payment", async (req, res) => {
      try {
        const { sessionId } = req.body;

        // stripe session verify
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // payment successful check
        if (session.payment_status === "paid") {
          const issueId = session.metadata.issueId;

          // timeline data
          // const timelineEntry = {
          //   title: "Issue boosted to High priority",
          //   date: new Date().toLocaleString(),
          // };

          // update issue
          const result = await issuesCollection.updateOne(
            {
              _id: new ObjectId(issueId),
            },
            {
              $set: {
                priority: "High",
              },

              // $push: {
              //   timeline: timelineEntry,
              // },
            },
          );

          return res.send({
            success: true,
            result,
          });
        }

        res.send({
          success: false,
        });
      } catch (error) {
        console.log(error);

        res.status(500).send({
          error: "Payment confirmation failed",
        });
      }
    });

    // CitizenDashboard apis
    app.get("/citizen-dashboard-stats/:email", async (req, res) => {
      const email = req.params.email;

      try {
        // total issues
        const totalIssues = await issuesCollection.countDocuments({
          reporterEmail: email,
        });
        // pending
        const pendingIssues = await issuesCollection.countDocuments({
          reporterEmail: email,
          status: "Pending",
        });

        // in progress
        const inProgressIssues = await issuesCollection.countDocuments({
          reporterEmail: email,
          status: "In Progress",
        });

        // resolved
        const resolvedIssues = await issuesCollection.countDocuments({
          reporterEmail: email,
          status: "Resolved",
        });

        // total payments
        // const totalPayments = await paymentsCollection.countDocuments({
        //   email: email,
        // });

        res.send({
          totalIssues,
          pendingIssues,
          inProgressIssues,
          resolvedIssues,
        });
      } catch (error) {
        res.status(500).send({
          message: "Failed to load dashboard stats",
        });
      }
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
