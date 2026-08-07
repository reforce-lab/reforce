import { z } from "zod";

export const healthResponse = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number(),
});

export const showHealth = { response: healthResponse } as const;
