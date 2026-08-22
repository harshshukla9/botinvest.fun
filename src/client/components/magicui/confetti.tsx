import { useEffect, type CSSProperties } from "react";
import confetti from "canvas-confetti";

export function Confetti({
  style,
}: {
  manualstart?: boolean;
  style?: CSSProperties;
}) {
  useEffect(() => {
    void confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.6 },
    });
  }, []);
  return <canvas style={style} aria-hidden="true" />;
}
