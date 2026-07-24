const express = require("express");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const serveStatic = require("serve-static");
const { readFileSync } = require("fs");
const { setupFdk } = require("@gofynd/fdk-extension-javascript/express");
const {
  SQLiteStorage,
} = require("@gofynd/fdk-extension-javascript/express/storage");
const sqliteInstance = new sqlite3.Database("session_storage.db");
const productRouter = express.Router();
const axios = require("axios");

const fdkExtension = setupFdk({
  api_key: process.env.EXTENSION_API_KEY,
  api_secret: process.env.EXTENSION_API_SECRET,
  base_url: process.env.EXTENSION_BASE_URL,
  cluster: process.env.FP_API_DOMAIN,
  callbacks: {
    auth: async (req) => {
      // Write you code here to return initial launch url after auth process complete
      if (req.query.application_id)
        return `${req.extension.base_url}/company/${req.query["company_id"]}/application/${req.query.application_id}`;
      else
        return `${req.extension.base_url}/company/${req.query["company_id"]}`;
    },

    uninstall: async (req) => {
      // Write your code here to cleanup data related to extension
      // If task is time taking then process it async on other process.
    },
  },
  storage: new SQLiteStorage(
    sqliteInstance,
    "exapmple-fynd-platform-extension",
  ), // add your prefix
  access_mode: "offline",
  webhook_config: {
    api_path: "/api/webhook-events",
    notification_email: "useremail@example.com",
    event_map: {
      "company/product/delete": {
        handler: (eventName) => {
          console.log(eventName);
        },
        version: "1",
      },
    },
  },
});

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? path.join(process.cwd(), "frontend", "public", "dist")
    : path.join(process.cwd(), "frontend");

const app = express();
const platformApiRoutes = fdkExtension.platformApiRoutes;

// Middleware to parse cookies with a secret key
app.use(cookieParser("ext.session"));

// Middleware to parse JSON bodies with a size limit of 2mb
app.use(
  bodyParser.json({
    limit: "2mb",
  }),
);

// Serve static files from the React dist directory
app.use(serveStatic(STATIC_PATH, { index: false }));

// FDK extension handler and API routes (extension launch routes)
app.use("/", fdkExtension.fdkHandler);

// Route to handle webhook events and process it.
app.post("/api/webhook-events", async function (req, res) {
  try {
    console.log(`Webhook Event: ${req.body.event} received`);
    await fdkExtension.webhookRegistry.processWebhook(req);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.log(`Error Processing ${req.body.event} Webhook`);
    return res.status(500).json({ success: false });
  }
});

const shipment_ids = {};

app.post("/api/webhook/shipment", async (req, res) => {
  try {
    const { company_id, payload } = req.body;
    // console.log("WEBHOOK TRIGGGERED:", company_id);

    if (!company_id) {
      console.error("company_id missing in webhook payload");
      return res
        .status(400)
        .json({ success: false, message: "company_id missing" });
    }
    const { shipment } = payload;
    const shipmentId = shipment?.shipment_id;

    if (!shipmentId) {
      console.error("shipment_id missing in webhook payload");
      return res
        .status(400)
        .json({ success: false, message: "shipment_id missing" });
    }

    if (shipment.status !== "bag_confirmed") {
      console.error(
        "Skipped due to invalid status",
        shipmentId,
        shipment.status,
      );
      return res
        .status(400)
        .json({ success: false, message: "shipment_id missing" });
    }

    if (!shipment_ids[shipmentId]) {
      shipment_ids[shipmentId] = 1;
    } else {
      console.error("shipment_id already processed:", shipmentId);
      return res
        .status(400)
        .json({ success: false, message: "shipment_id missing" });
    }
    console.log("Processing shipment webhook", {
      company_id,
      shipmentId,
    });

    const { data } = await axios.post(
      `https://api.fynd.com/service/panel/authentication/v1.0/company/${company_id}/oauth/token`,
      {
        grant_type: "client_credentials",
        client_id: "698414718fe04b36b843e605",
        client_secret: "gZXS3gVtzDIPo7i",
      },
    );
    const { access_token } = data || {};

    if (!access_token) {
      console.error("error generating access token");
      return res
        .status(400)
        .json({ error: "error generation access token", success: false });
    }

    const response = await axios.post(
      `https://api.fynd.com/service/platform/order-manage/v1.0/company/${company_id}/entity/lock-manager`,
      {
        action_type: "complete",
        action: "lock",
        entity_type: "shipments",
        unlock_before_transition: true,
        lock_after_transition: false,
        entities: [
          {
            id: shipmentId,
            reason_text: "Shipment locked due to invoice generation",
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      },
    );

    // console.log(response.data);

    const erpPayload = [{}];
    const timestamp = new Date().getTime();
    const invoice_payload = {
      force_transition: true,
      unlock_before_transition: true,
      lock_after_transition: false,
      task: false,
      statuses: [
        {
          shipments: [
            {
              identifier: shipmentId,
              products: [],
              data_updates: {
                products: [
                  {
                    filters: [{}],
                    data: {
                      store_invoice_id: timestamp,
                    },
                  },
                ],
                entities: [
                  {
                    filters: [{}],
                    data: {
                      store_invoice_id: timestamp,
                      meta: {
                        testfield: "value",
                      },
                    },
                  },
                ],
              },
            },
          ],
          status: "bag_invoiced",
          exclude_bags_next_state: null,
        },
      ],
    };

    const status_update = await axios.put(
      `https://api.fynd.com/service/portal/order-manage/v1.0/company/${company_id}/shipment/status-internal`,
      invoice_payload,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      },
    );

    console.log(JSON.stringify(status_update.data));
    return res.status(200).json({
      success: true,
      //   shipmentId,
    });
  } catch (error) {
    console.error(
      "Error processing shipment webhook:",
      error?.response?.data || error,
    );

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

productRouter.get("/", async function view(req, res, next) {
  try {
    const { platformClient } = req;
    const data = await platformClient.catalog.getProducts();
    return res.json(data);
  } catch (err) {
    next(err);
  }
});

// Get products list for application
productRouter.get(
  "/application/:application_id",
  async function view(req, res, next) {
    try {
      const { platformClient } = req;
      const { application_id } = req.params;
      const data = await platformClient
        .application(application_id)
        .catalog.getAppProducts();
      return res.json(data);
    } catch (err) {
      next(err);
    }
  },
);

// FDK extension api route which has auth middleware and FDK client instance attached to it.
platformApiRoutes.use("/products", productRouter);

// If you are adding routes outside of the /api path,
// remember to also add a proxy rule for them in /frontend/vite.config.js
app.use("/api", platformApiRoutes);

// Serve the React app for all other routes
app.get("*", (req, res) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(readFileSync(path.join(STATIC_PATH, "index.html")));
});

module.exports = app;
