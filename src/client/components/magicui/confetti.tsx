import type { ComponentPropsWithRef } from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type {
  CreateTypes as ConfettiInstance,
  GlobalOptions as ConfettiGlobalOptions,
  Options as ConfettiOptions
} from "canvas-confetti";
import confetti from "canvas-confetti";

type ConfettiApi = {
  fire: (options?: ConfettiOptions) => void;
};

type ConfettiProps = ComponentPropsWithRef<"canvas"> & {
  options?: ConfettiOptions;
  globalOptions?: ConfettiGlobalOptions;
  manualstart?: boolean;
};

export type ConfettiRef = ConfettiApi | null;

/** Official Magic UI Confetti component, installed via the shadcn registry. */
export const Confetti = forwardRef<ConfettiRef, ConfettiProps>(function Confetti(
  { options, globalOptions = { resize: true, useWorker: true }, manualstart = false, ...canvasProps },
  ref
) {
  const instanceRef = useRef<ConfettiInstance | null>(null);

  const canvasRef = useCallback(
    (node: HTMLCanvasElement | null) => {
      if (node) {
        if (!instanceRef.current) {
          instanceRef.current = confetti.create(node, { ...globalOptions, resize: true });
        }
      } else if (instanceRef.current) {
        instanceRef.current.reset();
        instanceRef.current = null;
      }
    },
    [globalOptions]
  );

  const fire = useCallback(
    (nextOptions: ConfettiOptions = {}) => instanceRef.current?.({ ...options, ...nextOptions }),
    [options]
  );
  const api = useMemo(() => ({ fire }), [fire]);

  useImperativeHandle(ref, () => api, [api]);

  useEffect(() => {
    if (!manualstart) void fire();
  }, [fire, manualstart]);

  return <canvas ref={canvasRef} {...canvasProps} />;
});

Confetti.displayName = "Confetti";
