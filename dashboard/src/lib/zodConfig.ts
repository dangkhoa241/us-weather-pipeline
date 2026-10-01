// Imported first in main.tsx: Zod checks once whether it may use `new Function` (its JIT) when the first object
// schema is created. The Content-Security-Policy forbids eval, so turn the JIT off before any schema exists.
import { z } from "zod";

z.config({ jitless: true });
