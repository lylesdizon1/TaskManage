import { useCallback } from 'react';
import { useToast } from '../contexts/ToastContext';

function extractMessage(error) {
  if (!error) return 'An unexpected error occurred';
  if (typeof error === 'string') return error;
  if (error.response?.data?.message) return error.response.data.message;
  if (error.response?.data?.error)   return error.response.data.error;
  if (error.message) return error.message;
  return 'An unexpected error occurred';
}

export function useErrorHandler() {
  const toast = useToast();

  const handleError = useCallback((error, context = '') => {
    const msg = extractMessage(error);
    const prefix = context ? `${context}: ` : '';
    console.error(`[ErrorHandler] ${prefix}${msg}`, error);
    toast.error(`${prefix}${msg}`);
  }, [toast]);

  const withErrorHandling = useCallback((fn, context = '') => {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        handleError(err, context);
        return null;
      }
    };
  }, [handleError]);

  return { handleError, withErrorHandling };
}
