import cors from "cors";
import express from "express";
import * as opaque from "@serenity-kit/opaque";
import Database, { readDatabaseFile, writeDatabaseFile } from "./database.js";
import { randomInt } from "crypto";

const activeSessions = {};
const dbFile = "./data.json";
const enableJsonFilePersistence = !process.argv.includes("--no-fs");

async function initDatabase(filePath) {
  await opaque.ready;
  if (!enableJsonFilePersistence) {
    return Database.empty(opaque.createServerSetup());
  }
  try {
    return readDatabaseFile(filePath);
  } catch (err) {
    console.log("failed to open database, initializing empty", err);
    const db = Database.empty(opaque.createServerSetup());
    return db;
  }
}

let db;
let serverSetup;

async function setupDb() {
  db = await initDatabase(dbFile);
  serverSetup = db.serverSetup;

  if (enableJsonFilePersistence) {
    writeDatabaseFile(dbFile, db);
    db.addListener(() => {
      writeDatabaseFile(dbFile, db);
    });
  }
}

const app = express();
app.use(express.json());
app.use(cors());

function sendError(res, status, error) {
  res.writeHead(status);
  res.end(JSON.stringify({ error }));
}

app.post("/register/start", (req, res) => {
  const { userIdentifier, registrationRequest } = req.body || {};

  if (!userIdentifier) return sendError(res, 400, "missing userIdentifier");
  if (!registrationRequest)
    return sendError(res, 400, "missing registrationRequest");
  if (db.hasUser(userIdentifier))
    return sendError(res, 400, "user already registered");

  const registrationResponse = opaque.serverRegistrationStart({
    serverSetup,
    userIdentifier,
    registrationRequest,
  });

  res.send({ registrationResponse });
  res.end();
});

app.post("/register/finish", (req, res) => {
  const { userIdentifier, registrationUpload } = req.body || {};
  if (!userIdentifier) return sendError(res, 400, "missing userIdentifier");
  if (!registrationUpload)
    return sendError(res, 400, "missing registrationUpload");
  const passwordFile = opaque.serverRegistrationFinish(registrationUpload);
  db.setUser(userIdentifier, passwordFile);
  res.writeHead(200);
  res.end();
});

app.post("/login/start", (req, res) => {
  const { userIdentifier, credentialRequest } = req.body || {};
  const passwordFile = userIdentifier && db.getUser(userIdentifier);

  if (!userIdentifier) return sendError(res, 400, "missing userIdentifier");
  if (!credentialRequest)
    return sendError(res, 400, "missing credentialRequest");
  if (!passwordFile) return sendError(res, 400, "user not registered");
  if (db.hasLogin(userIdentifier))
    return sendError(res, 400, "login already started");

  const { serverLogin, credentialResponse } = opaque.serverLoginStart({
    serverSetup,
    userIdentifier,
    passwordFile,
    credentialRequest,
  });

  db.setLogin(userIdentifier, serverLogin);
  res.send({ credentialResponse });
  res.end();
});

app.post("/login/finish", (req, res) => {
  const { userIdentifier, credentialFinalization } = req.body || {};
  const serverLogin = userIdentifier && db.getLogin(userIdentifier);

  if (!userIdentifier) return sendError(res, 400, "missing userIdentifier");
  if (!credentialFinalization)
    return sendError(res, 400, "missing credentialFinalization");
  if (!serverLogin) return sendError(res, 400, "login not started");

  const sessionKey = opaque.serverLoginFinish({
    serverSetup,
    credentialFinalization,
    serverLogin,
  });

  activeSessions[sessionKey] = userIdentifier;
  db.removeLogin(userIdentifier);
  res.writeHead(200);
  res.end();
});

app.post("/logout", (req, res) => {
  const auth = req.get("authorization");
  const user = auth && activeSessions[auth];
  if (!auth) return sendError(res, 401, "missing authorization header");
  if (!user) return sendError(res, 401, "no active session");

  delete activeSessions[userIdentifier];
  res.end();
});

app.get("/private", (req, res) => {
  const auth = req.get("authorization");
  const user = auth && activeSessions[auth];
  if (!auth) return sendError(res, 401, "missing authorization header");
  if (!user) return sendError(res, 401, "no active session");

  res.send({ message: `hello ${user} from opaque-authenticated world` });
  res.end();
});

function generateResetCode() {
  if (process.env.TEST_RESET_CODE) {
    return process.env.TEST_RESET_CODE;
  }

  return randomInt(1e10).toString();
}

app.post("/password/reset", (req, res) => {
  const { userIdentifier } = req.body || {};
  if (!userIdentifier) return sendError(res, 400, "missing userIdentifier");

  if (!db.hasUser(userIdentifier)) return sendError(res, 400, "user not found");

  const code = generateResetCode();

  console.log("==============================");
  console.log();
  console.log(" PASSWORD RESET CODE");
  console.log(` ${code}`);
  console.log();
  console.log("==============================");

  db.setResetCode(userIdentifier, code);
  res.end();
});

app.post("/password/reset/confirm", (req, res) => {
  const { userIdentifier, resetCode, registrationRequest } = req.body || {};

  if (!userIdentifier) return sendError(res, 400, "missing userIdentifier");

  if (!resetCode) return sendError(res, 400, "missing resetCode");
  if (!registrationRequest)
    return sendError(res, 400, "missing registrationRequest");

  const resetEntry = db.getResetCode(userIdentifier);
  if (resetEntry == null) {
    return sendError(res, 404, "reset code is invalid or expired");
  }

  db.removeResetCode(userIdentifier);

  if (resetEntry.code !== resetCode) {
    return sendError(res, 400, "reset code is invalid or expired");
  }

  const registrationResponse = opaque.serverRegistrationStart({
    serverSetup,
    userIdentifier,
    registrationRequest,
  });

  res.send({ registrationResponse });
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
