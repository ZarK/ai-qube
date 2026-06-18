import { z } from "zod";

export const aiqCheckFilesInputSchema = z.object({
  files: z.array(z.string()).min(1),
  outDir: z.string().optional(),
  stages: z.array(z.string()).optional(),
  profile: z.string().optional(),
});

export const aiqExplainDiagnosticsInputSchema = z
  .object({
    files: z.array(z.string()).optional(),
    outDir: z.string().optional(),
    stages: z.array(z.string()).optional(),
    profile: z.string().optional(),
    reportPath: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) =>
      value.reportPath !== undefined || (value.files !== undefined && value.files.length > 0),
    {
      message: "Provide files or reportPath.",
      path: ["files"],
    },
  );

export const aiqStatusInputSchema = z.object({
  cwd: z.string().optional(),
});
