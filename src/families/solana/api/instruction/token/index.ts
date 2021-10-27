import { ParsedInstruction } from "@solana/web3.js";
import { IX_STRUCTS, IX_TITLES, TokenInstructionType } from "./types";

import { ParsedInfo } from "../../validators";
import { create, Infer } from "superstruct";
import { PROGRAMS } from "../../constants";

export function parseSplTokenInstruction(
  ix: ParsedInstruction & { program: typeof PROGRAMS.SPL_TOKEN }
): TokenInstructionDescriptor {
  const parsed = create(ix.parsed, ParsedInfo);
  const { type: rawType, info } = parsed;
  const type = create(rawType, TokenInstructionType);
  const title = IX_TITLES[type];
  const struct = IX_STRUCTS[type];

  return {
    type,
    title: title as any,
    info: create(info, struct as any) as any,
  };
}

type TokenInstructionDescriptor = {
  [K in TokenInstructionType]: {
    title: typeof IX_TITLES[K];
    type: K;
    info: Infer<typeof IX_STRUCTS[K]>;
  };
}[TokenInstructionType];
