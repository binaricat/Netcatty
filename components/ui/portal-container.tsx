import React, { createContext, useContext } from 'react';

const PortalContainerContext = createContext<HTMLElement | null>(null);

export const PortalContainerProvider: React.FC<{
  container: HTMLElement | null;
  children: React.ReactNode;
}> = ({ container, children }) => (
  <PortalContainerContext.Provider value={container}>
    {children}
  </PortalContainerContext.Provider>
);

export const usePortalContainer = (): HTMLElement | null => useContext(PortalContainerContext);
