import React, { createContext, useContext } from 'react';
export const AccessContext = createContext(null);
export const useAccess = () => useContext(AccessContext);
export const useReadOnly = () => !!useAccess()?.accessScope;
