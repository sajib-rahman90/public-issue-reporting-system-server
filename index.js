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
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("issueTracking");

    // User block check api
    const verifyNotBlocked = async (req, res, next) => {
      try {
        const email = req.decoded_email;
        const user = await usersCollection.findOne({
          email,
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

    // Allissues pages apis
    app.get("/issues", async (req, res) => {
      try {
        const { search, category, status, priority, page = 1 } = req.query;
        const query = {};
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { category: { $regex: search, $options: "i" } },
            { location: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
          ];
        }

        if (category) query.category = category;
        if (status) query.status = status;
        if (priority) query.priority = priority;

        const limit = 9;
        const skip = (page - 1) * limit;
        const issues = await issuesCollection
          .find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await issuesCollection.countDocuments(query);

        res.send({
          issues,
          hasMore: skip + issues.length < total,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // Allissues pages apis
    app.patch("/issues/:id/upvote", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const email = req.decoded_email;
        const issue = await issuesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!issue) {
          return res.status(404).send({
            error: "Issue not found",
          });
        }
        if (issue.reporterEmail === email) {
          return res.status(400).send({
            error: "Cannot upvote own issue",
          });
        }

        if (issue?.upvotes?.includes(email)) {
          return res.status(400).send({
            error: "Already upvoted",
          });
        }

        const result = await issuesCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $push: {
              upvotes: email,
            },

            $inc: {
              upvote: 1,
            },
          },
        );

        if (!result.modifiedCount) {
          return res.status(400).send({
            error: "Upvote failed",
          });
        }

        await trackingCollection.insertOne({
          issueId: id,
          message: `Upvoted by ${email}`,
          updatedBy: email,
          status: issue.status,
          time: new Date(),
        });

        res.send({
          success: true,
          message: "Upvoted successfully",
        });
      } catch (error) {
        console.log(error);
        res.status(500).send({
          error: "Server error",
        });
      }
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

    app.patch("/issues/update/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const email = req.decoded_email;
        const { title, category, description, location } = req.body;
        const result = await issuesCollection.updateOne(
          {
            _id: new ObjectId(id),
          },
          {
            $set: {
              title,
              category,
              description,
              location,
              updatedAt: new Date(),
            },
          },
        );
        await trackingCollection.insertOne({
          issueId: id,
          message: `Issue updated by ${email}`,
          updatedBy: email,
          status: id.status,
          title: "Issue Updated",
          date: new Date(),
        });

        res.send(result);
      } catch (error) {
        console.log(error);
        res.status(500).send({
          message: "Update failed",
        });
      }
    });

    // Users report issues api
    app.post("/issues", async (req, res) => {
      const issueInfo = req.body;
      const email = issueInfo.reporterEmail;
      const user = await usersCollection.findOne({ email });
      const reportedCount = await issuesCollection.countDocuments({
        reporterEmail: email,
      });

      if (!user?.isPremium && reportedCount >= 3) {
        return res.status(403).send({
          message: "Free users can report only 3 issues",
        });
      }

      const result = await issuesCollection.insertOne(issueInfo);
      res.send({
        insertedId: result.insertedId,
      });
    });

    //Issue tracking collection
    app.post("/issue-tracking", async (req, res) => {
      const trackingInfo = req.body;
      const result = await trackingCollection.insertOne(trackingInfo);
      res.send(result);
    });

    // Issue for user
    app.get("/my-issues-count/:email", async (req, res) => {
      const email = req.params.email;
      const count = await issuesCollection.countDocuments({
        reporterEmail: email,
      });
      res.send({ count });
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

    //Latest resolved section api
    app.get("/latest-resolved-issues", async (req, res) => {
      try {
        const issues = await issuesCollection
          .find({
            status: "Resolved",
          })
          .sort({
            updatedAt: -1,
            createdAt: -1,
          })
          .limit(6)
          .toArray();
        res.send(issues);
      } catch (error) {
        console.log(error);
        res.status(500).send({
          message: "Failed to fetch latest resolved issues",
        });
      }
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

    //Udate issues
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

    //Boost payment related apis
    app.post("/issues/:id/create-checkout-session", async (req, res) => {
      const { id } = req.params;
      const { email, userName } = req.body;
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
          userName,
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
        console.log(session);
        // payment successful check
        if (session.payment_status !== "paid") {
          return res.send({
            success: false,
            message: "Payment not completed",
          });
        }
        // metadata
        const issueId = session.metadata.issueId;
        const userName = session.metadata.userName;
        const userEmail = session.metadata.email;
        // duplicate payment check
        const existingPayment = await paymentsCollection.findOne({
          issueId,
        });

        if (existingPayment) {
          return res.send({
            success: true,
            message: "Payment already processed",
          });
        }

        // issue priority update
        await issuesCollection.updateOne(
          {
            _id: new ObjectId(issueId),
          },

          {
            $set: {
              priority: "High",
            },
          },
        );

        // payment history save
        await paymentsCollection.insertOne({
          issueId,
          sessionId: session.id,
          transactionId: session.payment_intent,
          customerName: userName,
          customerEmail: userEmail,
          amount: session.amount_total / 100,
          status: "Boosted",
          paymentStatus: session.payment_status,
          createdAt: new Date(),
        });

        // tracking timeline save
        await trackingCollection.insertOne({
          issueId,
          sessionId: session.id,
          status: "Priority Boosted",
          message: "Issue priority upgraded to High after successful payment",
          updatedBy: "Citizen",
          userName: userName,
          userEmail: userEmail,
          createdAt: new Date(),
        });

        res.send({
          success: true,
          message: "Payment successful and timeline updated",
        });
      } catch (error) {
        console.log(error);
        res.status(500).send({
          success: false,
          message: "Payment confirmation failed",
        });
      }
    });

    //Subscribe premium related all apis
    app.post("/create-payment-session", async (req, res) => {
      try {
        const { email, name, price } = req.body;
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "bdt",
                product_data: {
                  name: "Premium Subscription",
                  description: "Unlimited issue submission access",
                },
                unit_amount: price * 100,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          customer_email: email,
          metadata: {
            email,
            name,
          },
          success_url: `${process.env.SITE_DOMAIN}/premium-success?session_id={CHECKOUT_SESSION_ID}&email=${email}`,
          cancel_url: `${process.env.SITE_DOMAIN}/payment-failed`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Stripe session failed" });
      }
    });

    //Premium payment success page api
    app.post("/confirm-premium-payment", async (req, res) => {
      try {
        const { sessionId, email } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== "paid") {
          return res.send({ success: false });
        }

        const name = session.metadata.name;
        // duplicate check
        // const existingPayment = await paymentsCollection.findOne({
        //   sessionId,
        // });

        // if (existingPayment) {
        //   return res.send({
        //     success: true,
        //     message: "Already processed",
        //   });
        // }
        await usersCollection.updateOne(
          { email },
          { $set: { isPremium: true } },
        );

        await paymentsCollection.insertOne({
          customerName: name,
          customerEmail: email,
          sessionId: session.id,
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          status: "Subscription",
          paymentStatus: session.payment_status,
          createdAt: new Date(),
        });

        await trackingCollection.insertOne({
          customerName: name,
          customerEmail: email,
          sessionId: session.id,
          status: "Subscription",
          transactionId: session.payment_intent,
          message: "Premium Payment is successful ",
          createdAt: new Date(),
        });

        res.send({ success: true });
      } catch (error) {
        console.log(error);
        res.status(500).send({ success: false });
      }
    });

    // CitizenDashboard start apis
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
        const totalPayments = await paymentsCollection.countDocuments({
          email: email,
        });

        res.send({
          totalIssues,
          pendingIssues,
          inProgressIssues,
          resolvedIssues,
          totalPayments,
        });
      } catch (error) {
        res.status(500).send({
          message: "Failed to load dashboard stats",
        });
      }
    });

    // Citizen Profile api
    app.get("/users/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send(user);
    });

    // Update Profile
    app.patch("/users/update/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const { name, photo } = req.body;
      const filter = { email };
      const updatedDoc = {
        $set: {
          name,
          photo,
        },
      };

      const result = await usersCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    //Admin Dashbord Start
    app.get("/admin/dashboard-stats", async (req, res) => {
      try {
        // issue stats
        const totalIssues = await issuesCollection.countDocuments();
        const resolvedIssues = await issuesCollection.countDocuments({
          status: "Resolved",
        });
        const pendingIssues = await issuesCollection.countDocuments({
          status: "Pending",
        });
        const rejectedIssues = await issuesCollection.countDocuments({
          status: "Rejected",
        });
        // payment stats
        const paymentData = await paymentsCollection.find({}).toArray();
        const totalPayment = paymentData.reduce(
          (sum, payment) => sum + Number(payment.amount || 0),
          0,
        );

        // latest issues
        const latestIssues = await issuesCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();

        // latest payments
        const latestPayments = await paymentsCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();

        const usersCollection = db.collection("users");
        const latestUsers = await usersCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();

        // chart data
        const chartData = [
          {
            name: "Resolved",
            value: resolvedIssues,
          },
          {
            name: "Pending",
            value: pendingIssues,
          },
          {
            name: "Rejected",
            value: rejectedIssues,
          },
        ];
        res.send({
          totalIssues,
          resolvedIssues,
          pendingIssues,
          rejectedIssues,
          totalPayment,
          latestIssues,
          latestPayments,
          latestUsers,
          chartData,
        });
      } catch (error) {
        console.log(error);
        res.status(500).send({
          message: "Dashboard data failed",
        });
      }
    });

    app.get("/admin/payments", async (req, res) => {
      try {
        const { email, status, search } = req.query;
        const query = {};
        if (email) {
          query.customerEmail = email;
        }
        if (status) {
          query.paymentStatus = status;
        }
        if (search) {
          query.$or = [
            { customerName: { $regex: search, $options: "i" } },
            { customerEmail: { $regex: search, $options: "i" } },
            { transactionId: { $regex: search, $options: "i" } },
          ];
        }

        const payments = await paymentsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(payments);
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    });

    //Admin Dashbord all apis
    app.get("/admin/issues", async (req, res) => {
      try {
        const issues = await issuesCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();

        res.send(issues);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch issues" });
      }
    });

    app.get("/staff", async (req, res) => {
      try {
        const staff = await usersCollection
          .find({ role: "staff" })
          .project({
            name: 1,
            email: 1,
          })
          .toArray();

        res.send(staff);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch staff" });
      }
    });

    app.patch("/admin/issues/assign/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { staffEmail, staffName } = req.body;

        const filter = { _id: new ObjectId(id) };

        const issue = await issuesCollection.findOne(filter);

        if (issue.assignedStaffEmail) {
          return res.status(400).send({ message: "Already assigned" });
        }

        const updateDoc = {
          $set: {
            assignedStaffEmail: staffEmail,
            assignedStaffName: staffName,
            assignedAt: new Date(),
          },
        };

        const result = await issuesCollection.updateOne(filter, updateDoc);

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Assignment failed" });
      }
    });

    app.patch("/admin/issues/reject/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid ID" });
        }

        const filter = { _id: new ObjectId(id) };

        const issue = await issuesCollection.findOne(filter);

        if (!issue) {
          return res.status(404).send({ message: "Issue not found" });
        }

        if (issue.status?.toLowerCase() !== "pending") {
          return res.status(400).send({
            message: "Only pending issues can be rejected",
          });
        }

        const result = await issuesCollection.updateOne(filter, {
          $set: { status: "Rejected" },
        });

        res.send(result);
      } catch (err) {
        console.log(err);
        res.status(500).send({ message: "Reject failed server error" });
      }
    });

    //Admin manages users api
    app.get("/admin/users", async (req, res) => {
      try {
        const users = await usersCollection
          .find({ role: "citizen" })
          .project({
            name: 1,
            email: 1,
            photo: 1,
            isBlocked: 1,
            isPremium: 1,
            subscriptionDate: 1,
          })
          .toArray();

        res.send(users);
      } catch (err) {
        res.status(500).send({
          message: "Failed to fetch users",
        });
      }
    });

    //Admin manages block--unblock users api
    app.patch("/admin/users/block/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const filter = {
          _id: new ObjectId(id),
        };
        const user = await usersCollection.findOne(filter);
        if (!user) {
          return res.status(404).send({
            message: "User not found",
          });
        }

        const updatedStatus = !user.isBlocked;
        const result = await usersCollection.updateOne(filter, {
          $set: {
            isBlocked: updatedStatus,
          },
        });
        res.send({
          success: true,
          isBlocked: updatedStatus,
          result,
        });
      } catch (err) {
        res.status(500).send({
          message: "Failed to update user status",
        });
      }
    });
    // ADMIN MANAGE USERS ALL API WITH FIREBASE LOGIN
    // GET ALL STAFF
    app.get("/admin/staff", async (req, res) => {
      try {
        const result = await usersCollection.find({ role: "staff" }).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({
          message: "Failed to fetch staff",
        });
      }
    });

    // CREATE STAFF
    app.post("/admin/staff", verifyFBToken, async (req, res) => {
      try {
        const { name, email, password, phone, photo } = req.body;
        // 1. CREATE FIREBASE USER
        const firebaseUser = await admin.auth().createUser({
          email,
          password,
          displayName: name,
          photoURL: photo,
        });

        // 2. SAVE TO MONGODB
        const staffData = {
          name,
          email,
          phone,
          photo,
          firebaseUID: firebaseUser.uid,
          role: "staff",
          isBlocked: false,
          createdAt: new Date(),
        };
        const result = await usersCollection.insertOne(staffData);
        res.send({
          success: true,
          insertedId: result.insertedId,
        });
      } catch (err) {
        console.log(err);
        res.status(500).send({ message: err.message });
      }
    });

    // UPDATE STAFF
    app.patch("/admin/staff/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;
        const filter = {
          _id: new ObjectId(id),
        };
        const updateDoc = {
          $set: {
            name: updatedData.name,
            phone: updatedData.phone,
            photo: updatedData.photo,
          },
        };
        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (err) {
        res.status(500).send({
          message: "Failed to update staff",
        });
      }
    });

    // DELETE STAFF
    app.delete("/admin/staff/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const filter = {
          _id: new ObjectId(id),
        };
        // FIND STAFF
        const staff = await usersCollection.findOne(filter);

        if (!staff) {
          return res.status(404).send({
            message: "Staff not found",
          });
        }
        // DELETE FIREBASE USER
        if (staff.firebaseUID) {
          await admin.auth().deleteUser(staff.firebaseUID);
        }
        // DELETE DATABASE USER
        const result = await usersCollection.deleteOne(filter);
        res.send({
          success: true,
          result,
        });
      } catch (err) {
        console.log(err);

        res.status(500).send({
          message: "Failed to delete staff",
        });
      }
    });
    // Admin payments api
    app.get("/admin/payments", async (req, res) => {
      try {
        const { email, status, search } = req.query;
        const query = {};
        if (email) {
          query.customerEmail = email;
        }

        if (status) {
          query.paymentStatus = status;
        }

        if (search) {
          query.$or = [
            { customerName: { $regex: search, $options: "i" } },
            { customerEmail: { $regex: search, $options: "i" } },
            { transactionId: { $regex: search, $options: "i" } },
          ];
        }
        const payments = await paymentsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(payments);
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    });

    //Admin Profile api
    app.get("/admin/profile", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const admin = await usersCollection.findOne({ email });
        if (!admin) {
          return res.status(404).send({ message: "Admin not found" });
        }
        res.send(admin);
      } catch (err) {
        res.status(500).send({ message: "Failed to get profile" });
      }
    });

    //Admin Profile update api
    app.put("/admin/profile", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const updatedData = req.body;
        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              name: updatedData.name,
              phone: updatedData.phone,
              photo: updatedData.photo,
            },
          },
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update profile" });
      }
    });

    //Staff Dashboards all api
    //Staff Profile api
    app.get("/staff/profile", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const staff = await usersCollection.findOne({
          email,
          role: "staff",
        });

        if (!staff) {
          return res.status(404).send({ message: "Staff not found" });
        }
        res.send(staff);
      } catch (err) {
        res.status(500).send({ message: "Failed to get staff profile" });
      }
    });

    //Staff Profile update api
    app.put("/staff/profile", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const { name, photo } = req.body;
        const result = await usersCollection.updateOne(
          { email, role: "staff" },
          {
            $set: {
              name,
              photo,
            },
          },
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update profile" });
      }
    });

    //Staff Assigned issues get api
    app.get("/staff/assigned-issues", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const { status, priority } = req.query;
        let query = {
          assignedStaffEmail: email,
        };
        if (status) query.status = status;
        if (priority) query.priority = priority;
        const issues = await issuesCollection
          .find(query)
          .sort({ upvote: -1, createdAt: -1 })
          .toArray();

        res.send(issues);
      } catch (err) {
        res.status(500).send({ message: "Failed to get issues" });
      }
    });

    //Staff Assigned issues update api
    app.patch("/staff/issues/status/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;
        const filter = { _id: new ObjectId(id) };
        const issue = await issuesCollection.findOne(filter);

        if (!issue) {
          return res.status(404).send({ message: "Issue not found" });
        }

        const result = await issuesCollection.updateOne(filter, {
          $set: {
            status,
          },
        });
        // timeline insert
        await trackingCollection.insertOne({
          issueId: id,
          message: `Status changed to ${status}`,
          status,
          createdAt: new Date(),
        });

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Status update failed" });
      }
    });

    //Staff Dashboard start  api
    app.get("/staff/dashboard", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        // all assigned issues
        const issues = await issuesCollection
          .find({ assignedStaffEmail: email })
          .toArray();
        const assigned = issues.length;
        const resolved = issues.filter((i) => i.status === "Resolved").length;
        const inProgress = issues.filter(
          (i) => i.status === "In-progress",
        ).length;
        // today tasks
        const today = new Date().toISOString().split("T")[0];
        const todayTasks = issues.filter((i) => {
          if (!i.assignedAt) return false;
          return i.assignedAt.toString().includes(today);
        });
        res.send({
          assigned,
          resolved,
          inProgress,
          todayTasks,
        });
      } catch (err) {
        res.status(500).send({ message: "Dashboard failed" });
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
