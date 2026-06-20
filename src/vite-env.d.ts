/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare module "*.yaml" {
  const data: Record<string, any>;
  export default data;
}

declare module "*.yml" {
  const data: Record<string, any>;
  export default data;
}
