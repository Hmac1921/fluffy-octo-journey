import { main } from "./src/no_db_calendar.js";

try {
  await main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
