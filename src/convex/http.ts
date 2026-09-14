import { httpRouter } from "convex/server";
import { auth } from "./auth";
import * as api from "./api";

const http = httpRouter();

auth.addHttpRoutes(http);

// ---------------------------------------------------------------------------
// RAEVOLT public API — versioned from day one (prompt §31)
// ---------------------------------------------------------------------------
http.route({ path: "/api/v1/health", method: "GET", handler: api.health });
http.route({ path: "/api/v1/payments", method: "POST", handler: api.createPayment });
http.route({ pathPrefix: "/api/v1/payments/", method: "GET", handler: api.getPayment });
http.route({ pathPrefix: "/api/v1/payments/", method: "POST", handler: api.refundPayment });
http.route({ path: "/api/v1/balance", method: "GET", handler: api.getBalance });
http.route({ path: "/api/v1/settlements", method: "GET", handler: api.listSettlements });

// ---------------------------------------------------------------------------
// Payments via payment link (public, authenticated by the link id)
// ---------------------------------------------------------------------------
http.route({ pathPrefix: "/api/v1/checkout/", method: "GET", handler: api.getLinkPublic });
http.route({ pathPrefix: "/api/v1/checkout/", method: "POST", handler: api.checkoutWithLink });

// ---------------------------------------------------------------------------
// Payouts (prompt §25)
// ---------------------------------------------------------------------------
http.route({ path: "/api/v1/payouts", method: "POST", handler: api.createPayout });
http.route({ path: "/api/v1/payouts", method: "GET", handler: api.listPayouts });

// ---------------------------------------------------------------------------
// Customers (prompt §20)
// ---------------------------------------------------------------------------
http.route({ path: "/api/v1/customers", method: "GET", handler: api.listCustomers });

// CORS preflight for the API surface
http.route({ path: "/api/v1/health", method: "OPTIONS", handler: api.corsHandler });
http.route({ path: "/api/v1/payments", method: "OPTIONS", handler: api.corsHandler });
http.route({ pathPrefix: "/api/v1/payments/", method: "OPTIONS", handler: api.corsHandler });
http.route({ path: "/api/v1/balance", method: "OPTIONS", handler: api.corsHandler });
http.route({ path: "/api/v1/settlements", method: "OPTIONS", handler: api.corsHandler });
http.route({ pathPrefix: "/api/v1/checkout/", method: "OPTIONS", handler: api.corsHandler });
http.route({ path: "/api/v1/payouts", method: "OPTIONS", handler: api.corsHandler });
http.route({ path: "/api/v1/customers", method: "OPTIONS", handler: api.corsHandler });

export default http;
