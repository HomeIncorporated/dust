import { publicApiApp } from "@front-api/middlewares/ctx";
import { publicApiAuth } from "@front-api/middlewares/public_api_auth";

import assistant from "./assistant";
import featureFlags from "./feature_flags";
import mcp from "./mcp";
import spaces from "./spaces";
import verifiedDomains from "./verified_domains";

// Mounted at /api/v1/w/:wId. Every route below inherits publicApiAuth, which
// resolves the Authenticator from sandbox token, OAuth bearer, or API key
// and stashes it on the context.
const app = publicApiApp();

app.use("*", publicApiAuth);

app.route("/assistant", assistant);
app.route("/feature_flags", featureFlags);
app.route("/mcp", mcp);
app.route("/spaces", spaces);
app.route("/verified_domains", verifiedDomains);

export default app;
