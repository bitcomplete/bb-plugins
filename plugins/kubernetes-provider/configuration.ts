import { z } from "zod";

// Named CPU/memory shapes a machine pod can ask for. Stored as a JSON string
// setting because settings are flat scalars; the plugin parses it.
const DEFAULT_RESOURCE_CLASSES = {
  small: { cpu: "1", memory: "2Gi" },
  medium: { cpu: "2", memory: "4Gi" },
  large: { cpu: "4", memory: "8Gi" },
};

const resourceClassSchema = z
  .object({
    cpu: z.string().min(1),
    memory: z.string().min(1),
    limits: z
      .object({ cpu: z.string().min(1), memory: z.string().min(1) })
      .partial()
      .optional(),
  })
  .strict();

export const resourceClassesSchema = z.record(z.string(), resourceClassSchema);

export type ResourceClass = z.infer<typeof resourceClassSchema>;

// Node placement. Both are passed through to the pod spec as-is once they
// parse, so the shapes mirror Kubernetes' own.
export const nodeSelectorSchema = z.record(z.string().min(1), z.string());

export const tolerationSchema = z
  .object({
    key: z.string().min(1).optional(),
    operator: z.enum(["Equal", "Exists"]).optional(),
    value: z.string().optional(),
    effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
    tolerationSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();

export const tolerationsSchema = z.array(tolerationSchema);

export type Toleration = z.infer<typeof tolerationSchema>;

// A setting left blank or at its empty default yields to an environment
// variable of the server process, so a deployment can carry the value
// declaratively while the UI can still override it.
function withEnvDefault(raw: string, emptyDefault: string, env: string | undefined): string {
  const trimmed = raw.trim();
  const untouched = trimmed.length === 0 || trimmed.replace(/\s+/gu, "") === emptyDefault;
  return untouched && env !== undefined && env.trim().length > 0 ? env : raw;
}

function parsesAs(schema: z.ZodType, value: string): boolean {
  try {
    schema.parse(JSON.parse(value));
    return true;
  } catch {
    return false;
  }
}

export const SETTING_DESCRIPTORS = {
  resourceClasses: {
    type: "string",
    label: "Resource classes",
    description:
      'JSON map of class name → {cpu, memory, limits?}. Requests use cpu/memory; limits default to the same values.',
    experimental_multiline: true,
    experimental_schema: z.string().refine((value) => {
      try {
        resourceClassesSchema.parse(JSON.parse(value));
        return true;
      } catch {
        return false;
      }
    }, "Resource classes must be a JSON object of {cpu, memory} entries"),
    default: JSON.stringify(DEFAULT_RESOURCE_CLASSES, null, 2),
  },
  defaultResourceClass: {
    type: "string",
    label: "Default resource class",
    default: "medium",
  },
  worktreePath: {
    type: "string",
    label: "Worktree mount path",
    description:
      "Where the machine's persistent volume is mounted inside the agent container. Project checkouts and thread worktrees live under it.",
    default: "/workspace",
  },
  volumeSize: {
    type: "string",
    label: "Volume size",
    description: "Size of the persistent volume created for each new machine.",
    default: "20Gi",
  },
  storageClass: {
    type: "string",
    label: "Storage class",
    default: "local-path",
  },
  readyTimeoutSeconds: {
    type: "number",
    label: "Pod ready timeout (seconds)",
    experimental_schema: z.number().int().min(10).max(3600),
    default: 300,
  },
  deleteVolumeOnRemove: {
    type: "boolean",
    label: "Delete volume when a machine is removed",
    description:
      "Off keeps the machine's PersistentVolumeClaim after removal so a machine created later with the same name reattaches it.",
    default: false,
  },
  nodeSelector: {
    // Falls back to BB_K8S_NODE_SELECTOR while left at {}.
    type: "string",
    label: "Node selector",
    description:
      'JSON object of node label → value that machine pods must match, e.g. {"role":"github-runner"}. Empty object places pods anywhere.',
    experimental_multiline: true,
    experimental_schema: z
      .string()
      .refine(
        (value) => parsesAs(nodeSelectorSchema, value),
        "nodeSelector must be a JSON object of label → value",
      ),
    default: "{}",
  },
  tailscaleImage: {
    type: "string",
    label: "Tailscale sidecar image",
    description:
      "Image for the tailscale sidecar that puts a machine pod on the tailnet. Only used when the server has minter credentials; see the Cluster access section of the README.",
    default: "tailscale/tailscale:v1.102.4",
  },
  tolerations: {
    type: "string",
    label: "Tolerations",
    description:
      'JSON array of Kubernetes tolerations, e.g. [{"key":"github-runner","operator":"Equal","value":"true","effect":"NoSchedule"}].',
    experimental_multiline: true,
    experimental_schema: z
      .string()
      .refine(
        (value) => parsesAs(tolerationsSchema, value),
        "tolerations must be a JSON array of toleration objects",
      ),
    default: "[]",
  },
} as const;

export interface RawSettings {
  resourceClasses: string;
  defaultResourceClass: string;
  worktreePath: string;
  volumeSize: string;
  storageClass: string;
  readyTimeoutSeconds: number;
  deleteVolumeOnRemove: boolean;
  nodeSelector: string;
  tolerations: string;
  tailscaleImage: string;
}

export interface ResolvedSettings {
  image: string;
  // Project images by name, from BB_K8S_AGENT_IMAGE_<NAME> in the server
  // environment (NAME upper-cased, dashes as underscores). Read when a pod
  // is created, so when the server restarts with a new value, machines that
  // name the image move on their next suspend/resume.
  projectImages: Record<string, string>;
  resourceClasses: Record<string, ResourceClass>;
  defaultResourceClass: string;
  worktreePath: string;
  volumeSize: string;
  storageClass: string;
  readyTimeoutMs: number;
  deleteVolumeOnRemove: boolean;
  nodeSelector: Record<string, string>;
  tolerations: Toleration[];
  tailscaleImage: string;
}

export type SettingsResolution =
  | { ok: true; settings: ResolvedSettings }
  | { ok: false; message: string };

const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/u;

const PROJECT_IMAGE_ENV_PREFIX = "BB_K8S_AGENT_IMAGE_";
export const PROJECT_IMAGE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;

export function projectImageEnvVar(name: string): string {
  return `${PROJECT_IMAGE_ENV_PREFIX}${name.toUpperCase().replace(/-/gu, "_")}`;
}

function readProjectImages(env: NodeJS.ProcessEnv): Record<string, string> {
  const images: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PROJECT_IMAGE_ENV_PREFIX) || value === undefined) continue;
    const image = value.trim();
    if (image.length === 0) continue;
    images[key.slice(PROJECT_IMAGE_ENV_PREFIX.length).toLowerCase().replace(/_/gu, "-")] = image;
  }
  return images;
}

export function resolveSettings(raw: RawSettings): SettingsResolution {
  // The deployment owns the agent image, so a server rollout is the only
  // thing that changes it.
  const image = (process.env.BB_K8S_AGENT_IMAGE ?? "").trim();
  if (image.length === 0) {
    return { ok: false, message: "Set BB_K8S_AGENT_IMAGE in the server environment." };
  }
  const projectImages = readProjectImages(process.env);
  let resourceClasses: Record<string, ResourceClass>;
  try {
    resourceClasses = resourceClassesSchema.parse(JSON.parse(raw.resourceClasses));
  } catch {
    return {
      ok: false,
      message: "resourceClasses must be a JSON object of {cpu, memory} entries.",
    };
  }
  if (Object.keys(resourceClasses).length === 0) {
    return { ok: false, message: "resourceClasses must define at least one class." };
  }
  const defaultResourceClass = raw.defaultResourceClass.trim();
  if (!(defaultResourceClass in resourceClasses)) {
    return {
      ok: false,
      message: `defaultResourceClass "${defaultResourceClass}" is not one of ${Object.keys(resourceClasses).join(", ")}.`,
    };
  }
  const worktreePath = raw.worktreePath.trim();
  if (!worktreePath.startsWith("/")) {
    return { ok: false, message: "worktreePath must be an absolute path." };
  }
  const volumeSize = raw.volumeSize.trim();
  if (!QUANTITY.test(volumeSize)) {
    return { ok: false, message: `volumeSize "${volumeSize}" is not a Kubernetes quantity.` };
  }
  const storageClass = raw.storageClass.trim();
  if (storageClass.length === 0) {
    return { ok: false, message: "storageClass must not be blank." };
  }
  let nodeSelector: Record<string, string>;
  try {
    nodeSelector = nodeSelectorSchema.parse(
      JSON.parse(withEnvDefault(raw.nodeSelector, "{}", process.env.BB_K8S_NODE_SELECTOR)),
    );
  } catch {
    return { ok: false, message: "nodeSelector must be a JSON object of label → value." };
  }
  let tolerations: Toleration[];
  try {
    tolerations = tolerationsSchema.parse(
      JSON.parse(withEnvDefault(raw.tolerations, "[]", process.env.BB_K8S_TOLERATIONS)),
    );
  } catch {
    return { ok: false, message: "tolerations must be a JSON array of toleration objects." };
  }
  const tailscaleImage = raw.tailscaleImage.trim();
  if (tailscaleImage.length === 0) {
    return { ok: false, message: "tailscaleImage must not be blank." };
  }
  return {
    ok: true,
    settings: {
      image,
      projectImages,
      resourceClasses,
      defaultResourceClass,
      worktreePath,
      volumeSize,
      storageClass,
      readyTimeoutMs: raw.readyTimeoutSeconds * 1000,
      deleteVolumeOnRemove: raw.deleteVolumeOnRemove,
      nodeSelector,
      tolerations,
      tailscaleImage,
    },
  };
}
