import { bootWindow } from "@/services/boot"

void bootWindow("main", () => import("./App.vue"))
