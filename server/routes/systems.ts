import { Router } from "express";
import { SYSTEMS } from "../library/systems.js";

export const systemsRouter = Router();

systemsRouter.get("/", (_req, res) => {
  res.json({ systems: SYSTEMS });
});
