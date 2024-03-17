import * as opaque from "@proactice/opaque-wasm";
import { randomInt } from "crypto";
import * as dotenv from "dotenv";
import express from "express";
import InMemoryStore, {
  readDatabaseFile,
  writeDatabaseFile,
} from "./InMemoryStore.js";
import RedisStore from "./RedisStore.js";
import cookieParser from "cookie-parser";
import {
  LoginFinishParams,
  LoginStartParams,
  RegisterFinishParams,
  RegisterStartParams,
} from "./schema.js";
import setRateLimit from "express-rate-limit";

dotenv.config({ path: "../../.env" });

const dbFile = "./data.json";
const enableJsonFilePersistence = !readEnvFlag("DISABLE_FS");
const enableRedis = readEnvFlag("ENABLE_REDIS");

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const REDIS_URL = process.env.REDIS_URL || DEFAULT_REDIS_URL;

/**
 * @param {string} key
 */
function readEnvFlag(key) {
  const value = process.env[key];
  if (value == null) return false;
  try {
    return Boolean(JSON.parse(value));
  } catch (err) {
    return false;
  }
}

function getOpaqueServerSetup() {
  const serverSetup = process.env.OPAQUE_SERVER_SETUP;
  if (serverSetup == null) {
    console.error(process.env);
    throw new Error("OPAQUE_SERVER_SETUP env variable is not set");
  }
  return serverSetup;
}

/**
 * @param {string} filePath
 */
async function initInMemoryStore(filePath) {
  await opaque.ready;
  if (!enableJsonFilePersistence) {
    return InMemoryStore.empty();
  }
  try {
    const db = readDatabaseFile(filePath);
    console.log(`database successfully initialized from file "${filePath}"`);
    return db;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      console.log(
        `no database file "${filePath}" found, initializing empty database`,
      );
    } else {
      console.error(
        `failed to open database file "${filePath}", initializing empty database`,
        err,
      );
    }
    const db = InMemoryStore.empty();
    return db;
  }
}

/**
 * @type {ServerSimple.Datastore}
 */
let db;

async function setUpInMemoryStore() {
  const memDb = await initInMemoryStore(dbFile);

  if (enableJsonFilePersistence) {
    writeDatabaseFile(dbFile, memDb);
    memDb.addListener(() => {
      writeDatabaseFile(dbFile, memDb);
    });
  }
  db = memDb;
}

async function setUpRedisStore() {
  try {
    const redis = new RedisStore(REDIS_URL);
    redis.onError((err) => {
      console.error("Redis Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
    await redis.connect();
    db = redis;
    console.log("connected to redis at", REDIS_URL);
  } catch (err) {
    console.error(
      "Redis Setup Error:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

async function setupDb() {
  if (enableRedis) {
    await setUpRedisStore();
  } else {
    await setUpInMemoryStore();
  }
}

function generateSessionId() {
  return randomInt(1e9, 1e10).toString();
}

const rateLimitMiddleware = setRateLimit({
  windowMs: 60 * 1000,
  max: 40,
  message: "You have exceeded 40 requests/min",
  headers: true,
});

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(rateLimitMiddleware);

/**
 *
 * @param {import("express").Response} res
 * @param {number} status
 * @param {string} error
 */
function sendError(res, status, error) {
  res.writeHead(status);
  res.end(JSON.stringify({ error }));
}

app.post("/register/start", async (req, res) => {
  let userIdentifier, registrationRequest;
  try {
    const values = RegisterStartParams.parse(req.body);
    userIdentifier = values.userIdentifier;
    registrationRequest = values.registrationRequest;
  } catch (err) {
    return sendError(res, 400, "Invalid input values");
  }

  const userExists = await db.hasUser(userIdentifier);
  if (userExists) {
    return sendError(res, 400, "user already registered");
  }

  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup: getOpaqueServerSetup(),
    userIdentifier,
    registrationRequest,
  });

  res.send({ registrationResponse });
  res.end();
});

app.post("/register/finish", async (req, res) => {
  let userIdentifier, registrationRecord;
  try {
    const values = RegisterFinishParams.parse(req.body);
    userIdentifier = values.userIdentifier;
    registrationRecord = values.registrationRecord;
  } catch (err) {
    return sendError(res, 400, "Invalid input values");
  }

  const existingUser = await db.getUser(userIdentifier);
  if (!existingUser) {
    await db.setUser(userIdentifier, registrationRecord);
  }

  // return a 200 even if the user already exists to avoid leaking
  // the information if the user exists or not
  res.writeHead(200);
  res.end();
});

app.post("/login/start", async (req, res) => {
  let userIdentifier, startLoginRequest;
  try {
    const values = LoginStartParams.parse(req.body);
    userIdentifier = values.userIdentifier;
    startLoginRequest = values.startLoginRequest;
  } catch (err) {
    return sendError(res, 400, "Invalid input values");
  }

  const registrationRecord = await db.getUser(userIdentifier);
  if (!registrationRecord) return sendError(res, 400, "user not registered");

  const loginExists = await db.hasLogin(userIdentifier);
  if (loginExists) {
    return sendError(res, 400, "login already started");
  }

  const { serverLoginState, loginResponse } = opaque.server.startLogin({
    serverSetup: getOpaqueServerSetup(),
    userIdentifier,
    registrationRecord,
    startLoginRequest,
  });

  await db.setLogin(userIdentifier, serverLoginState);

  res.send({ loginResponse });
  res.end();
});

app.post("/login/finish", async (req, res) => {
  let userIdentifier, finishLoginRequest;
  try {
    const values = LoginFinishParams.parse(req.body);
    userIdentifier = values.userIdentifier;
    finishLoginRequest = values.finishLoginRequest;
  } catch (err) {
    return sendError(res, 400, "Invalid input values");
  }

  const serverLoginState = await db.getLogin(userIdentifier);
  if (!serverLoginState) return sendError(res, 400, "login not started");

  const { sessionKey } = opaque.server.finishLogin({
    finishLoginRequest,
    serverLoginState,
  });

  const sessionId = generateSessionId();
  await db.setSession(sessionId, { userIdentifier, sessionKey });
  await db.removeLogin(userIdentifier);

  res.cookie("session", sessionId, { httpOnly: true });
  res.writeHead(200);
  res.end();
});

app.post("/logout", async (req, res) => {
  const sessionId = req.cookies.session;
  if (!sessionId) return sendError(res, 401, "not authorized");

  const session = await db.getSession(sessionId);
  if (!session) return sendError(res, 401, "invalid session");

  await db.clearSession(sessionId);

  res.clearCookie("session");
  res.end();
});

app.get("/private", async (req, res) => {
  const sessionId = req.cookies.session;
  if (!sessionId) return sendError(res, 401, "not authorized");

  const session = await db.getSession(sessionId);
  if (!session) return sendError(res, 401, "invalid session");

  res.send({
    message: `hello ${session.userIdentifier} from opaque-authenticated world`,
  });
  res.end();
});

async function main() {
  await setupDb();
  const port = 8089;
  app.listen(port, () => {
    console.log(`listening on port ${port}`);
  });
}

main();
