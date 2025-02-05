import { EMPTY, merge } from "rxjs";
import type { Observable } from "rxjs";
import { catchError } from "rxjs/operators";
import Transport from "@ledgerhq/hw-transport";
type Discovery = Observable<{
  type: "add" | "remove";
  id: string;
  name: string;
}>;
// NB open/close/disconnect semantic will have to be refined...
export type TransportModule = {
  // unique transport name that identify the transport module
  id: string;
  // open a device by an id, this id must be unique across all modules
  // you can typically prefix it with `something|` that identify it globally
  // returns falsy if the transport module can't handle this id
  // here, open means we want to START doing something with the transport
  open: (id: string) => Promise<Transport> | null | undefined;
  // here, close means we want to STOP doing something with the transport
  close?: (
    transport: Transport,
    id: string
  ) => Promise<void> | null | undefined;
  // disconnect/interrupt a device connection globally
  // returns falsy if the transport module can't handle this id
  disconnect: (id: string) => Promise<void> | null | undefined;
  // optional observable that allows to discover a transport
  discovery?: Discovery;
};
const modules: TransportModule[] = [];
export const registerTransportModule = (module: TransportModule) => {
  modules.push(module);
};
export const discoverDevices = (
  accept: (module: TransportModule) => boolean = () => true
): Discovery => {
  const all: Discovery[] = [];

  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];

    if (m.discovery && accept(m)) {
      all.push(m.discovery);
    }
  }

  return merge(
    ...all.map((o) =>
      o.pipe(
        catchError((e) => {
          console.warn(`One Transport provider failed: ${e}`);
          return EMPTY;
        })
      )
    )
  );
};
export const open = (deviceId: string): Promise<Transport> => {
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    const p = m.open(deviceId);
    if (p) return p;
  }

  return Promise.reject(new Error(`Can't find handler to open ${deviceId}`));
};
export const close = (
  transport: Transport,
  deviceId: string
): Promise<void> => {
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    const p = m.close && m.close(transport, deviceId);
    if (p) return p;
  }

  // fallback on an actual close
  return transport.close();
};
export const disconnect = (deviceId: string): Promise<void> => {
  for (let i = 0; i < modules.length; i++) {
    const dis = modules[i].disconnect;
    const p = dis(deviceId);

    if (p) {
      return p;
    }
  }

  return Promise.reject(
    new Error(`Can't find handler to disconnect ${deviceId}`)
  );
};
