const express = require("express");
const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.use(express.json());
app.get("/", (_req, res) =>
  res.json({
    message: "Welcome to Node.js Docker Application",
    status: "running",
  }),
);
app.get("/health", (_req, res) =>
  res.json({ status: "UP", timestamp: new Date().toISOString() }),
);
app.get("/users", (_req, res) =>
  res.json([
    { id: 1, name: "John" },
    { id: 2, name: "David" },
    { id: 3, name: "Alice" },
  ]),
);
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on port ${PORT}`),
);
