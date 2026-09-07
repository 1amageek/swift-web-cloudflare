import { DurableObject } from "cloudflare:workers";
import { ApplicationRuntimeRegistry } from "../../Adapter/Templates/Deployment/common/src/application-runtime.ts";

const registry = new ApplicationRuntimeRegistry();
const discarded = new Map();

// This fixture verifies routing ownership on workerd, not Swift execution.
export class RuntimeOwner extends DurableObject {
  constructor(context, environment) {
    super(context, environment);
    this.memory = new WebAssembly.Memory({ initial: 1 });
    this.delivered = 0;
    this.registration = registry.register({
      rendered: (id) => {
        if (id !== this.registration.id) throw new Error("Crossed runtime identity");
        this.delivered++;
      },
    }, context.storage);
    discarded.set(this.registration.id, {
      owner: new WeakRef(this), memory: new WeakRef(this.memory),
      storage: new WeakRef(context.storage),
    });
  }

  inspect() {
    return { id: this.registration.id, delivered: this.delivered };
  }

  release() {
    const id = this.registration.id;
    registry.release(this.registration);
    this.registration = null;
    return { id, released: registry.runtime(id) === undefined && registry.durableStorage(id) === undefined };
  }
}

export default {
  async fetch(request, environment) {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    if (url.pathname === "/inspect") {
      return Response.json(await environment.OWNERS.getByName(url.searchParams.get("name")).inspect());
    }
    if (url.pathname === "/release") {
      return Response.json(await environment.OWNERS.getByName(url.searchParams.get("name")).release());
    }
    if (url.pathname === "/dispatch") {
      try {
        registry.dispatch(id, "rendered", Number(url.searchParams.get("rendering")));
        return Response.json({ delivered: true });
      } catch (error) {
        return Response.json({ delivered: false, message: error.message });
      }
    }
    const references = discarded.get(id);
    return Response.json({
      ownerReleased: references.owner.deref() === undefined,
      memoryReleased: references.memory.deref() === undefined,
      storageReleased: references.storage.deref() === undefined,
      routeReleased: registry.runtime(id) === undefined,
      storageRouteReleased: registry.durableStorage(id) === undefined,
    });
  },
};
