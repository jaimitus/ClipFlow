import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Hook optimizado para apps desktop de alto rendimiento.
 * Previene re-renderizados innecesarios y mejora la fluidez.
 */

/**
 * Debounce para funciones que se ejecutan frecuentemente (ej: scroll, resize)
 */
export function useDebouncedCallback<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): T {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: Parameters<T>) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      callbackRef.current(...args);
    }, delay);
  }, [delay]) as T;
}

/**
 * Throttle para limitar la frecuencia de ejecución
 */
export function useThrottledCallback<T extends (...args: any[]) => any>(
  callback: T,
  limit: number
): T {
  const lastCallRef = useRef(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCallRef.current >= limit) {
      lastCallRef.current = now;
      callbackRef.current(...args);
    } else if (!timeoutRef.current) {
      timeoutRef.current = setTimeout(() => {
        lastCallRef.current = Date.now();
        timeoutRef.current = null;
        callbackRef.current(...args);
      }, limit - (now - lastCallRef.current));
    }
  }, [limit]) as T;
}

/**
 * Intersection Observer optimizado para lazy loading
 */
export function useIntersectionObserver<T extends Element>(
  options?: IntersectionObserverInit
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = React.useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting);
    }, options || { threshold: 0.1 });

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [options]);

  return [ref as React.RefObject<T | null>, isVisible];
}

/**
 * Hook para pre-cargar recursos críticos
 */
export function usePreload(resources: string[]): void {
  useEffect(() => {
    resources.forEach((src) => {
      if (src.endsWith(".mp4") || src.endsWith(".webm")) {
        const video = document.createElement("video");
        video.preload = "auto";
        video.src = src;
      } else if (src.endsWith(".jpg") || src.endsWith(".png") || src.endsWith(".webp")) {
        const img = new Image();
        img.src = src;
      }
    });
  }, [resources]);
}

/**
 * Hook para gestión eficiente de animaciones con requestAnimationFrame
 */
export function useRafLoop(callback: (deltaTime: number) => void, active: boolean = true): void {
  const requestRef = useRef<number>();
  const previousTimeRef = useRef<number>();
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!active) return;

    const animate = (time: number) => {
      if (previousTimeRef.current !== undefined) {
        const deltaTime = time - previousTimeRef.current;
        callbackRef.current(deltaTime);
      }
      previousTimeRef.current = time;
      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);

    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
      previousTimeRef.current = undefined;
    };
  }, [active]);
}
