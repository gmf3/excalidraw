import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { isExcalidrawPlusSignedUser } from "../app_constants";
import { PIZARRA_ENABLED } from "../pizarra/pizarra";
import { PizarraHojas } from "../pizarra/PizarraUI";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";

export const AppFooter = React.memo(
  ({ onChange }: { onChange: () => void }) => {
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
          {PIZARRA_ENABLED ? (
            <PizarraHojas />
          ) : (
            !isExcalidrawPlusSignedUser && <EncryptedIcon />
          )}
        </div>
      </Footer>
    );
  },
);
