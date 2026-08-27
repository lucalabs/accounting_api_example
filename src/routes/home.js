import { Router } from "express";

import { requireCredentials } from "../guards.js";

const router = Router();

router.get("/", requireCredentials, (req, res) => {
  res.render("layout", { page: "pages/connection", title: "Connection" });
});

export default router;
