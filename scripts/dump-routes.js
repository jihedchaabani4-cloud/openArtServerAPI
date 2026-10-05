import express from "express";
import apiRouter from "../src/api/routes.js";

export function extractRoutes(appOrRouter, basePath = "") {
  const routes = [];

  function cleanRegex(regexp, fastSlash) {
    if (fastSlash || !regexp) return "";
    const match = regexp.toString()
      .replace("\\/?(?=\\/|$)", "")
      .replace("^\\", "")
      .replace("\\/?$", "")
      .replace("(?=\\/|$)", "")
      .replace(/^\/\^/, "")
      .replace(/\/\i$/, "")
      .replace(/\\\//g, "/")
      .replace(/\$$/, "");
    return match === "/" ? "" : match;
  }

  function getMiddlewareNames(layerStack) {
    return (layerStack || []).map((l) => {
      if (l.name && l.name !== "<anonymous>" && l.name !== "bound dispatch") {
        return l.name;
      }
      // Check closure names or function string hints
      const fnStr = l.handle?.toString() || "";
      if (fnStr.includes("requireAuth") || fnStr.includes("supabase.auth.getUser")) return "requireAuth";
      if (fnStr.includes("rateLimit") || fnStr.includes("consume(")) return "rateLimit";
      if (fnStr.includes("multer") || fnStr.includes("multipart")) return "multer";
      return l.name || "anonymous";
    });
  }

  function traverse(stack, currentPath = "", routerMiddlewares = []) {
    if (!stack || !Array.isArray(stack)) return;

    // First collect router-level middlewares in this router
    const currentRouterMiddlewares = [...routerMiddlewares];
    for (const layer of stack) {
      if (!layer.route && layer.handle && !layer.handle.stack && layer.name !== "router") {
        const name = layer.name || (layer.handle?.toString().includes("requireAuth") ? "requireAuth" : "anonymous");
        currentRouterMiddlewares.push(name);
      }
    }

    for (const layer of stack) {
      if (layer.route) {
        // Direct route
        const route = layer.route;
        const subPath = route.path === "/" ? "" : route.path;
        const fullPath = `${currentPath}${subPath}`.replace(/\/+/g, "/");

        const methods = Object.keys(route.methods).map((m) => m.toUpperCase());
        const routeMiddlewares = getMiddlewareNames(route.stack);
        const ignored = ["query", "expressInit", "anonymous", "bound dispatch", "router"];
        const combinedMiddlewares = [...new Set([...currentRouterMiddlewares, ...routeMiddlewares])]
          .filter((m) => !ignored.includes(m));

        for (const method of methods) {
          routes.push({
            method,
            path: fullPath,
            middlewares: combinedMiddlewares,
          });
        }
      } else if (layer.name === "router" || (layer.handle && layer.handle.stack)) {
        // Nested router
        let mountPath = cleanRegex(layer.regexp, layer.handle?.fast_slash);
        if (mountPath && !mountPath.startsWith("/")) mountPath = "/" + mountPath;
        const nextPath = `${currentPath}${mountPath}`.replace(/\/+/g, "/");
        traverse(layer.handle.stack, nextPath, currentRouterMiddlewares);
      }
    }
  }

  // Mount apiRouter on a dummy express app to get full /api tree
  const app = express();
  app.use("/api", apiRouter);

  traverse(app._router.stack, "");

  // Sort by path then method
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return routes;
}

if (process.argv[1]?.endsWith("dump-routes.js")) {
  const routes = extractRoutes();
  console.log(`TOTAL ROUTES DUMPED: ${routes.length}\n`);
  console.log("| Method | Path | Middlewares | Requires Auth | Rate Limited |");
  console.log("|---|---|---|---|---|");
  for (const r of routes) {
    const hasAuth = r.middlewares.some((m) => m.toLowerCase().includes("auth"));
    const hasRateLimit = r.middlewares.some((m) => m.toLowerCase().includes("ratelimit") || m.toLowerCase().includes("limit"));
    console.log(`| ${r.method} | ${r.path} | ${r.middlewares.join(", ") || "none"} | ${hasAuth ? "YES" : "NO"} | ${hasRateLimit ? "YES" : "NO"} |`);
  }
  process.exit(0);
}
