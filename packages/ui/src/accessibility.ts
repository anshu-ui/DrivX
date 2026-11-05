import { useEffect, useState } from 'react';
import { AccessibilityInfo, useWindowDimensions } from 'react-native';

/**
 * The device's font scale, re-read whenever the user changes it.
 *
 * A fixed `lineHeight` in design units does not grow with that setting, so text
 * needs the current scale to keep its leading proportional — otherwise large
 * accessibility text clips its own descenders. The web build's dimensions
 * payload carries no scale (the browser zooms instead), hence the fallback.
 */
export function useFontScale(): number {
  const { fontScale } = useWindowDimensions();
  return Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      if (active) setReduced(value);
    });
    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
