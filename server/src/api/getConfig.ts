import { FastifyRequest, FastifyReply } from "fastify";
import { createRequire } from "module";
import { CONFIGURED_SOCIAL_PROVIDERS, DISABLE_SIGNUP, LITE_DASHBOARD, MAPBOX_TOKEN } from "../lib/const.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

export async function getConfig(_: FastifyRequest, reply: FastifyReply) {
  return reply.send({
    disableSignup: DISABLE_SIGNUP,
    mapboxToken: MAPBOX_TOKEN,
    liteDashboard: LITE_DASHBOARD,
    // Quels boutons de connexion sociale la page de login doit afficher. Ne
    // contient QUE des booléens : aucun identifiant OAuth ne sort d'ici.
    socialProviders: CONFIGURED_SOCIAL_PROVIDERS,
  });
}

export async function getVersion(_: FastifyRequest, reply: FastifyReply) {
  return reply.send({ version });
}
