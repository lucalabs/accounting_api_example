import { Router } from "express";

import * as discovery from "../discovery.js";
import { requireCredentials } from "../guards.js";

const router = Router();

router.get("/", requireCredentials, async (req, res) => {
  res.render("layout", {
    page: "pages/connection",
    title: "Connection",
    metadata: await discovery.discover(req.credentials.host),
  });
});

export default router;
