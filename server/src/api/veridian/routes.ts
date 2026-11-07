import { FastifyInstance } from "fastify";
import { listHubUsers, syncHubUser } from "./hubUsers.js";
import { issueMagicLink } from "./issueMagicLink.js";

/**
 * Plugin à part : le parseur ne vaut que pour ces routes. La signature porte sur le
 * corps brut, il le laisse intact pour que les handlers vérifient les octets reçus.
 */
export async function hubRoutes(fastify: FastifyInstance) {
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  fastify.post("/sso/issue-magic-link", issueMagicLink);
  fastify.get("/hub/users", listHubUsers);
  fastify.post("/hub/users/sync", syncHubUser);
}
