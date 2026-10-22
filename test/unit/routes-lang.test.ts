import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRoutes, type DetectedRoute, type SourceFile } from '../../src/importers/routes';

/** Spring, ASP.NET Core, Python (FastAPI, Flask, Django), Laravel, Go and Rust: the routes in the text of the files. */

const file = (path: string, text: string): SourceFile => ({ path, text });
const listed = (files: readonly SourceFile[]): string[] => detectRoutes(files).routes.map(route => `${route.method} ${route.path}`);
const one = (path: string, text: string): string[] => listed([file(path, text)]);
const brief = (route: DetectedRoute): [string, string, string | undefined, string[], string[], string | undefined] => [route.method, route.path, route.handler, route.queryParams, route.headerParams, route.body];

// ---- Spring ----

test('Spring: the class path, the verbs, the parameters and the body', () => {
  const result = detectRoutes([file('src/main/java/app/UserController.java', `package app;
@RestController
@RequestMapping("/api/users")
public class UserController {
  @GetMapping
  public List<User> list(@RequestParam(name = "q", required = false) String q, @RequestParam int page, @RequestHeader("X-Trace") String trace) { return null; }

  @GetMapping("/{id}")
  public User get(@PathVariable Long id) { return null; }

  @PostMapping(value = "/new", consumes = "application/json")
  public User create(@RequestBody User user, @RequestHeader String lang) { return null; }

  @PutMapping(path = {"/a/{id}", "/b/{id}"})
  public void update(@PathVariable("id") Long id) {}

  @DeleteMapping("/{id:\\\\d+}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void remove(@PathVariable Long id) {}

  @PatchMapping("/{id}/avatar")
  public void avatar(@RequestPart MultipartFile file) {}
}
`)]);
  assert.deepEqual(result.routes.map(brief), [
    ['GET', '/api/users', 'list', ['q', 'page'], ['X-Trace'], undefined],
    ['GET', '/api/users/{id}', 'get', [], [], undefined],
    ['POST', '/api/users/new', 'create', [], ['lang'], 'json'],
    ['PUT', '/api/users/a/{id}', 'update', [], [], undefined],
    ['DELETE', '/api/users/{id}', 'remove', [], [], undefined],
    ['PATCH', '/api/users/{id}/avatar', 'avatar', [], [], 'form']
  ]);
  assert.ok(result.routes.every(route => route.group === 'UserController' && route.framework === 'Spring'));
});

test('Spring: RequestMapping with a method, with several, and with none', () => {
  const result = detectRoutes([file('A.java', `@Controller
public class A {
  @RequestMapping(value = "/one", method = RequestMethod.POST) public void one() {}
  @RequestMapping(value = "/two", method = {RequestMethod.PUT, RequestMethod.PATCH}) public void two() {}
  @RequestMapping("/three") public void three() {}
}`)]);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path} ${route.handler}`), ['POST /one one', 'PUT /two two', 'PATCH /two two', 'GET /three three']);
  assert.ok(result.notes.some(note => /1 route answers for every method/.test(note)));
});

test('Spring: only a controller has routes; a path that is a constant is counted and left out', () => {
  const result = detectRoutes([file('B.java', `@Service
public class Service { @GetMapping("/not-a-controller") void x() {} }
@FeignClient(name = "x")
public interface Client { @GetMapping("/feign") String get(); }
@RestController
@RequestMapping(Paths.BASE)
class Base { @GetMapping("/skipped-by-class") void a() {} }
@RestController
class Plain {
  @GetMapping(Paths.USERS) void b() {}
  @GetMapping("/ok") void c() {}
}`)]);
  assert.deepEqual(result.routes.map(route => `${route.group} ${route.path}`), ['Plain /ok']);
  assert.ok(result.notes.some(note => /2 routes were left out/.test(note)), result.notes.join('|'));
});

test('Spring: the annotation of the class can be before the one that makes it a controller, and two controllers in a file do not mix', () => {
  assert.deepEqual(listed([file('C.java', `@RequestMapping("/first")
@RestController
class First { @GetMapping("/a") void a() {} }
@RestController
class Second { @GetMapping("/b") void b() {} }`)]), ['GET /first/a', 'GET /b']);
});

test('Spring: Kotlin', () => {
  const result = detectRoutes([file('src/main/kotlin/PetController.kt', `@RestController
@RequestMapping("/pets")
class PetController(private val service: PetService) {
  @GetMapping
  fun list(@RequestParam name: String?, @RequestParam(value = "age", required = false) age: Int?): List<Pet> = service.all()

  @PostMapping("/{id}")
  fun create(@PathVariable id: Long, @RequestBody pet: Pet, @RequestHeader("X-A") a: String) = service.add(pet)

  @GetMapping(value = ["/x", "/y"])
  suspend fun other() = 1
}`)]);
  assert.deepEqual(result.routes.map(brief), [
    ['GET', '/pets', 'list', ['name', 'age'], [], undefined],
    ['POST', '/pets/{id}', 'create', [], ['X-A'], 'json'],
    ['GET', '/pets/x', 'other', [], [], undefined]
  ]);
});

test('Spring: the port and the context path are in the base address', () => {
  const route = file('src/main/java/A.java', '@RestController class A { @GetMapping("/x") void x() {} }');
  assert.equal(detectRoutes([route]).baseUrl, 'http://localhost:8080');
  assert.equal(detectRoutes([route, file('src/main/resources/application.properties', 'server.port=8081\nserver.servlet.context-path=/svc\n')]).baseUrl, 'http://localhost:8081/svc');
  assert.equal(detectRoutes([route, file('application.yml', 'spring:\n  application:\n    name: x\nserver:\n  port: 9090 # the port\n  servlet:\n    context-path: /api/\n')]).baseUrl, 'http://localhost:9090/api');
  assert.equal(detectRoutes([route, file('application.yaml', 'server:\n  port: 7000\n')]).baseUrl, 'http://localhost:7000');
  assert.equal(detectRoutes([route, file('application.properties', '# server.port=1111\n')]).baseUrl, 'http://localhost:8080', 'a comment is not a setting');
});

// ---- ASP.NET Core ----

test('ASP.NET Core: the controller, the route tokens, the verbs and the parameters', () => {
  const result = detectRoutes([file('Controllers/PetsController.cs', `[ApiController]
[Route("api/[controller]")]
public class PetsController : ControllerBase {
  [HttpGet]
  public ActionResult<List<Pet>> List([FromQuery] int page, string filter, [FromHeader(Name = "X-Key")] string key) { }

  [HttpGet("{id:int}")]
  public ActionResult<Pet> Get(int id, CancellationToken token) { }

  [HttpPost]
  public IActionResult Create([FromBody] Pet pet) { }

  [HttpPut("{id}")]
  public IActionResult Update(int id, Pet pet) { }

  [HttpDelete("{id}")]
  [Authorize]
  public IActionResult Delete(int id) { }

  [HttpPost("upload")]
  public IActionResult Upload(IFormFile file) { }

  [HttpGet("[action]")]
  public IActionResult Search([FromQuery(Name = "q")] string text) { }

  [HttpGet("~/health")]
  public IActionResult Health() { }

  [HttpGet]
  [Route("alt")]
  public IActionResult Alt() { }
}`)]);
  assert.deepEqual(result.routes.map(brief), [
    ['GET', '/api/Pets', 'List', ['page', 'filter'], ['X-Key'], undefined],
    ['GET', '/api/Pets/{id}', 'Get', [], [], undefined],
    ['POST', '/api/Pets', 'Create', [], [], 'json'],
    ['PUT', '/api/Pets/{id}', 'Update', [], [], 'json'],
    ['DELETE', '/api/Pets/{id}', 'Delete', [], [], undefined],
    ['POST', '/api/Pets/upload', 'Upload', [], [], 'form'],
    ['GET', '/api/Pets/Search', 'Search', ['q'], [], undefined],
    ['GET', '/health', 'Health', [], [], undefined],
    ['GET', '/api/Pets/alt', 'Alt', [], [], undefined]
  ]);
});

test('ASP.NET Core: an abstract class, a class that is not a controller, several verbs on one method, a template that is a constant', () => {
  const result = detectRoutes([file('Controllers/Others.cs', `public abstract class BaseController : ControllerBase { [HttpGet("base")] public IActionResult B() { } }
public class Service { [HttpGet("service")] public IActionResult S() { } }
[Route("v1/[controller]")]
public class ThingsController : Controller {
  [HttpGet("a")]
  [HttpPost("b")]
  public IActionResult Two() { }
  [HttpGet(Routes.Things)]
  public IActionResult Const() { }
  [HttpGet(Name = "named")]
  public IActionResult Named(string q, Thing thing) { }
}`)]);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path} ${route.handler}`).sort(), ['GET /v1/Things Named', 'GET /v1/Things/a Two', 'POST /v1/Things/b Two'].sort());
  assert.deepEqual(result.routes.find(route => route.handler === 'Named')?.queryParams, ['q'], 'a class that is not an ApiController has no body inferred');
  assert.equal(result.routes.find(route => route.handler === 'Named')?.body, undefined);
  assert.ok(result.notes.some(note => /1 route was left out/.test(note)));
});

test('ASP.NET Core: minimal APIs, with groups', () => {
  const result = detectRoutes([file('Program.cs', `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/", () => "hi");
var api = app.MapGroup("/api");
var v1 = api.MapGroup("/v1");
api.MapPost("/things", Handlers.Create);
v1.MapGet("/things/{id:int}", GetThing);
v1.MapDelete("/things/{id}", (int id) => 1);
app.MapPut("/p", Update);
app.MapPatch("/q", () => 1);
app.MapGet(Routes.X, () => 1);`)]);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path} ${route.handler ?? ''}`), [
    'GET / ', 'POST /api/things Handlers.Create', 'GET /api/v1/things/{id} GetThing', 'DELETE /api/v1/things/{id} ', 'PUT /p Update', 'PATCH /q '
  ]);
  assert.ok(result.routes.every(route => route.group === 'Program'));
});

test('ASP.NET Core: the base address is in launchSettings.json or appsettings.json', () => {
  const controller = file('Controllers/AController.cs', '[ApiController][Route("a")] public class AController : ControllerBase { [HttpGet] public int G() { } }');
  assert.equal(detectRoutes([controller]).baseUrl, 'http://localhost:5000');
  assert.equal(detectRoutes([controller, file('Properties/launchSettings.json', '{"profiles":{"web":{"applicationUrl":"https://localhost:7001;http://localhost:5123"}}}')]).baseUrl, 'http://localhost:5123');
  assert.equal(detectRoutes([controller, file('Properties/launchSettings.json', '{"profiles":{"web":{"applicationUrl":"https://localhost:7001"}}}')]).baseUrl, 'https://localhost:7001');
  assert.equal(detectRoutes([controller, file('appsettings.json', '{"Urls":"http://*:6000"}')]).baseUrl, 'http://localhost:6000');
  assert.equal(detectRoutes([controller, file('Properties/launchSettings.json', 'not json')]).baseUrl, 'http://localhost:5000');
});

// ---- Python ----

test('FastAPI: the routes, their parameters, a router with a prefix that is included in the application', () => {
  const files = [
    file('app/main.py', `from fastapi import FastAPI
from .routers import items
app = FastAPI()
app.include_router(items.router, prefix="/api")

@app.get("/ping")
async def ping():
    return "pong"
`),
    file('app/routers/items.py', `from fastapi import APIRouter, Header, Query
router = APIRouter(prefix="/items", tags=["items"])

@router.get("/{item_id}")
async def read(item_id: int, q: str = None, limit: int = Query(10), user_agent: str = Header(None), db: Session = Depends(get_db)):
    pass

@router.post("/", status_code=201)
async def create(item: Item, background: BackgroundTasks):
    pass

@router.put("/{item_id}")
def replace(item_id: int, item: Item = Body(...)):
    pass
`)
  ];
  const result = detectRoutes(files);
  assert.deepEqual(result.routes.map(brief), [
    ['GET', '/ping', 'ping', [], [], undefined],
    ['GET', '/api/items/{item_id}', 'read', ['q', 'limit'], ['user-agent'], undefined],
    ['POST', '/api/items', 'create', [], [], 'json'],
    ['PUT', '/api/items/{item_id}', 'replace', [], [], 'json']
  ]);
  assert.deepEqual(result.frameworks, ['FastAPI']);
});

test('FastAPI: a router in the same file, a module that is imported as a name, and the port', () => {
  const files = [
    file('main.py', `from fastapi import FastAPI, APIRouter
from api.v2 import users as users_module
import uvicorn
app = FastAPI()
local = APIRouter(prefix="/local")
@local.get("/x")
def x(): pass
app.include_router(local, prefix="/l")
app.include_router(users_module.router, prefix="/v2")
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8123)
`),
    file('src/api/v2/users.py', 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/users")\ndef users(): pass\n')
  ];
  const result = detectRoutes(files);
  assert.deepEqual(result.routes.map(route => route.path).sort(), ['/l/local/x', '/v2/users']);
  assert.equal(result.baseUrl, 'http://localhost:8123');
});

test('Flask: route with methods, the converters of a path, a blueprint with a prefix and the verbs of Flask 2', () => {
  const files = [
    file('web/app.py', `from flask import Flask
from .admin import bp as admin_bp
app = Flask(__name__)
app.register_blueprint(admin_bp, url_prefix="/admin")

@app.route("/hello/<name>", methods=["GET", "POST"])
def hello(name): pass

@app.route("/plain")
def plain(): pass

@app.get("/v2/<int:id>/<path:rest>")
def v2(id, rest): pass

@app.route(PATH)
def dynamic(): pass

if __name__ == "__main__":
    app.run(port=5050)
`),
    file('web/admin.py', 'from flask import Blueprint\nbp = Blueprint("admin", __name__, url_prefix="/panel")\n@bp.route("/users", methods=["DELETE"])\ndef users(): pass\n')
  ];
  const result = detectRoutes(files);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path}`).sort(), [
    'DELETE /admin/panel/users', 'GET /hello/{name}', 'GET /plain', 'GET /v2/{id}/{rest}', 'POST /hello/{name}'
  ].sort());
  assert.ok(result.routes.every(route => route.framework === 'Flask'));
  assert.equal(result.baseUrl, 'http://localhost:5050');
});

test('Python: a route in a docstring, in a comment or on something that is not a router is not a route', () => {
  assert.deepEqual(one('a.py', `from fastapi import FastAPI
app = FastAPI()
"""
@app.get("/doc")
"""
# @app.get("/comment")
@client.get("/client")
def c(): pass
@app.get("/real")
def r(): pass
`), ['GET /real']);
});

test('Django: the patterns of urls.py, the include of another file, and the methods that are not said', () => {
  const files = [
    file('proj/urls.py', `from django.urls import path, include
urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("shop.urls")),
    path("", views.home),
]`),
    file('shop/urls.py', `from django.urls import path, re_path
urlpatterns = [
    path("products/<int:pk>/", views.detail, name="detail"),
    path("products/", views.ProductList.as_view()),
    re_path(r"^legacy/(?P<year>[0-9]{4})/$", views.legacy),
]`),
    file('shop/views.py', 'def detail(request, pk): pass')
  ];
  const result = detectRoutes(files);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path} ${route.handler}`), [
    'GET / views.home', 'GET /api/products/{pk} views.detail', 'GET /api/products views.ProductList.as_view', 'GET /api/legacy/{year} views.legacy'
  ]);
  assert.ok(result.routes.every(route => route.framework === 'Django'));
  assert.equal(result.baseUrl, 'http://localhost:8000');
  assert.ok(result.notes.some(note => /4 routes answer for every method/.test(note)), result.notes.join('|'));
});

// ---- Laravel ----

test('Laravel: the verbs, the groups of every form, the controllers and match', () => {
  const result = detectRoutes([file('routes/web.php', `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/', fn () => view('welcome'));
Route::post('/login', [AuthController::class, 'login'])->name('login');
Route::get('/old', 'LegacyController@index');
Route::prefix('api')->middleware('auth')->group(function () {
    Route::get('/users/{id}', [UserController::class, 'show']);
    Route::prefix('v1')->group(function () {
        Route::delete('/users/{id?}', [UserController::class, 'destroy']);
    });
});
Route::group(['prefix' => 'admin', 'middleware' => 'can:x'], function () {
    Route::put('/settings', 'SettingsController@update');
});
Route::controller(OrderController::class)->group(function () {
    Route::get('/orders', 'index');
});
Route::match(['get', 'post'], '/m', [MController::class, 'go']);
Route::any('/any', fn () => 1);
Route::view('/about', 'about');
// Route::get('/commented', fn () => 1);
Route::get($dynamic, fn () => 1);
`)]);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path} ${route.group} ${route.handler ?? ''}`), [
    'GET / web ', 'POST /login AuthController login', 'GET /old LegacyController index',
    'GET /api/users/{id} UserController show', 'DELETE /api/v1/users/{id} UserController destroy', 'PUT /admin/settings SettingsController update',
    'GET /orders OrderController index', 'GET /m MController go', 'POST /m MController go', 'GET /any web ', 'GET /about web '
  ]);
  assert.ok(result.notes.some(note => /1 route was left out/.test(note)));
});

test('Laravel: resource and apiResource make the routes of a controller, also nested, with only and except', () => {
  const result = detectRoutes([file('routes/web.php', `<?php
Route::resource('photos', PhotoController::class);
Route::apiResource('posts', PostController::class)->except(['destroy']);
Route::resource('photos.comments', CommentController::class)->only(['index', 'show']);
`)]);
  // The routes of one line are in the order of the methods, then of the paths.
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path} ${route.handler}`), [
    'GET /photos index', 'GET /photos/create create', 'GET /photos/{photo} show', 'GET /photos/{photo}/edit edit', 'POST /photos store', 'PUT /photos/{photo} update', 'DELETE /photos/{photo} destroy',
    'GET /posts index', 'GET /posts/{post} show', 'POST /posts store', 'PUT /posts/{post} update',
    'GET /photos/{photo}/comments index', 'GET /photos/{photo}/comments/{comment} show'
  ]);
});

test('Laravel: the parameter of a resource is the singular of its name', () => {
  const result = detectRoutes([file('routes/web.php', `<?php
Route::resource('categories', C::class)->only(['show']);
Route::resource('addresses', C::class)->only(['show']);
Route::resource('statuses', C::class)->only(['show']);
Route::resource('boxes', C::class)->only(['show']);
Route::resource('news', C::class)->only(['show']);
Route::resource('posts', C::class)->only(['show']);
Route::resource('analysis', C::class)->only(['show']);
`)]);
  assert.deepEqual(result.routes.map(route => route.path), ['/categories/{category}', '/addresses/{address}', '/statuses/{status}', '/boxes/{box}', '/news/{news}', '/posts/{post}', '/analysis/{analysis}']);
});

test('Laravel: the file routes/api.php has the prefix /api that Laravel gives it', () => {
  const result = detectRoutes([file('routes/api.php', "<?php\nRoute::get('/ping', fn () => 1);\nRoute::prefix('v1')->group(function () { Route::get('/x', fn () => 1); });")]);
  assert.deepEqual(result.routes.map(route => route.path), ['/api/ping', '/api/v1/x']);
  assert.ok(result.notes.some(note => /routes\/api\.php/.test(note)));
  assert.equal(result.baseUrl, 'http://localhost:8000');
});

// ---- Go ----

test('Go: gin with groups, echo, fiber, and what is a client', () => {
  const result = detectRoutes([file('main.go', `package main
import "github.com/gin-gonic/gin"
func main() {
  r := gin.Default()
  v1 := r.Group("/v1")
  admin := v1.Group("/admin")
  v1.GET("/users/:id", handlers.GetUser)
  v1.POST("/users", handlers.Create)
  admin.DELETE("/files/*path", h.Del)
  r.GET("/health", func(c *gin.Context) { c.Get("user"); v := c.Get("/not-a-route") })
  r.Any("/any", h)
  http.Get("/client")
  // r.GET("/commented", h)
  r.Run(":9000")
}
`)]);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path} ${route.handler ?? ''}`), [
    'GET /v1/users/{id} handlers.GetUser', 'POST /v1/users handlers.Create', 'DELETE /v1/admin/files/{path} h.Del', 'GET /health ', 'GET /any h'
  ]);
  assert.ok(result.routes.every(route => route.framework === 'Gin'));
  assert.equal(result.baseUrl, 'http://localhost:9000');
});

test('Go: echo and fiber write the verbs in their own way', () => {
  assert.deepEqual(one('echo.go', 'import "github.com/labstack/echo/v4"\nfunc f(e *echo.Echo) { e.GET("/a/:id", h); g := e.Group("/g"); g.POST("/b", h) }'), ['GET /a/{id}', 'POST /g/b']);
  assert.deepEqual(one('fiber.go', 'import "github.com/gofiber/fiber/v2"\nfunc f(app *fiber.App) { app.Get("/a/:id", h); api := app.Group("/api"); api.Post("/b", h); app.Listen(":3010") }'), ['GET /a/{id}', 'POST /api/b']);
  const fiber = detectRoutes([file('fiber.go', 'import "github.com/gofiber/fiber/v2"\nfunc f(app *fiber.App) { app.Get("/a", h); app.Listen(":3010") }')]);
  assert.equal(fiber.baseUrl, 'http://localhost:3010');
  assert.deepEqual(fiber.frameworks, ['Fiber']);
});

test('Go: chi routes and the nested Route functions, and gorilla with Methods', () => {
  assert.deepEqual(one('chi.go', `import ("github.com/go-chi/chi/v5"; "net/http")
func router() http.Handler {
  r := chi.NewRouter()
  r.Get("/ping", ping)
  r.Route("/users", func(r chi.Router) {
    r.Get("/", list)
    r.Post("/", create)
    r.Route("/{id}", func(r chi.Router) {
      r.Get("/", get)
      r.Delete("/", del)
    })
  })
  r.Group(func(r chi.Router) { r.Get("/grouped", g) })
  return r
}`), ['GET /ping', 'GET /users', 'POST /users', 'GET /users/{id}', 'DELETE /users/{id}', 'GET /grouped']);
  assert.deepEqual(one('mux.go', `import "github.com/gorilla/mux"
func f() {
  r := mux.NewRouter()
  api := r.PathPrefix("/api").Subrouter()
  api.HandleFunc("/items/{id:[0-9]+}", h).Methods("GET", "PUT")
  r.HandleFunc("/home", home)
}`), ['GET /api/items/{id}', 'PUT /api/items/{id}', 'GET /home']);
});

test('Go: net/http with the method in the pattern', () => {
  const result = detectRoutes([file('std.go', `package main
import "net/http"
func main() {
  mux := http.NewServeMux()
  mux.HandleFunc("GET /items/{id}", getItem)
  mux.HandleFunc("POST example.com/items", postItem)
  mux.HandleFunc("/any", any)
  http.HandleFunc("/other", other)
  http.Handle("/h", handler)
  http.ListenAndServe(":8085", mux)
}`)]);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path} ${route.handler}`), [
    'GET /items/{id} getItem', 'POST /items postItem', 'GET /any any', 'GET /other other', 'GET /h handler'
  ]);
  assert.ok(result.routes.every(route => route.framework === 'net/http'));
  assert.equal(result.baseUrl, 'http://localhost:8085');
});

test('Go: httprouter', () => {
  assert.deepEqual(one('r.go', 'import "github.com/julienschmidt/httprouter"\nfunc f() { router := httprouter.New(); router.GET("/a/:name", h); router.POST("/b", h) }'), ['GET /a/{name}', 'POST /b']);
});

// ---- Rust ----

test('Rust: Actix and Rocket', () => {
  const actix = detectRoutes([file('src/main.rs', `use actix_web::{get, post, web, App, HttpServer};
#[get("/users/{id}")]
async fn show(path: web::Path<u32>) -> String { String::new() }

#[post("/users")]
async fn create(body: web::Json<User>) -> String { String::new() }

#[post("/form")]
pub async fn form(body: web::Form<Login>) {}

#[actix_web::main]
async fn main() { HttpServer::new(|| App::new().service(show)).bind(("127.0.0.1", 8090)).unwrap(); }
`)]);
  assert.deepEqual(actix.routes.map(route => [route.method, route.path, route.handler, route.body, route.framework]), [
    ['GET', '/users/{id}', 'show', undefined, 'Actix'], ['POST', '/users', 'create', 'json', 'Actix'], ['POST', '/form', 'form', 'form', 'Actix']
  ]);
  assert.equal(actix.baseUrl, 'http://localhost:8090');
  const rocket = detectRoutes([file('src/main.rs', `#[macro_use] extern crate rocket;
#[get("/hello/<name>")]
fn hello(name: &str) -> String { name.to_string() }
#[post("/items", data = "<item>")]
fn add(item: Json<Item>) {}
#[launch]
fn rocket() -> _ { rocket::build().mount("/api", routes![hello, add]) }
`)]);
  assert.deepEqual(rocket.routes.map(route => `${route.method} ${route.path} ${route.framework}`), ['GET /api/hello/{name} Rocket', 'POST /api/items Rocket']);
  assert.equal(rocket.baseUrl, 'http://localhost:8000');
});
