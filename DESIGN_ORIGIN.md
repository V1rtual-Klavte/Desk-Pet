初版
一、	架构
原始消息OriginMessage->
核心引擎：【
PreProcessor：初始化
SessionEngine：会话管理
State/StateLoop：状态机
ToolEngine：工具引擎
】->
Tool System【
Bash命令；
Agent tool：子agent  team/fork；
MCP；
Skill；
文件操作；
】（调用前：安全保证模块SafetyControl）
->
<-  Context Engine（指定上下文大小）
【
System Prompt；
Prompt 生成器；
附件管理器；
Memory：【
Memory System：长期记忆 短期记忆管理
】
】
->回复生成器：【
人格  分层  表情控制  人格核心：状态维护 监测用户状态 主动行为控制
】->UI展示
二、	核心loop
OriginMessage->
PreProcessor：slash命令？执行返回
拼SystemPrompt 
Memory处理
->
（plan）->
请求模型->
解析输出->
工具调用？子agent？skill？（调用前传递安全规则）->
模型判断合预期则往下  不合则回去
->合预期或者达到限制 maxretry  usage等
->回复生成器

在loop中要做：
usage（token消耗，以及上下文使用多少了等）统计；
状态（agent，人格）管理；
人格主动行为控制；
安全校验

三、	Memory
1.	长期记忆（大小暂定）
全局，MEMORY.md（指针注册表）：【
CANDY.md：用户手写，系统级，类似CLAUDE.md
User.md：用户画像，以及用户相关的信息
Outside.md：外部指针，在哪里找什么东西
Project：会话上下文指针  元数据 用sessionid定位
】
主agent写这个文件，（显式或隐式）
Fork subagent后台补记忆（当前turn结束） （只读操作）
2.	短期记忆
会话级 SESSION_MEMORY.md：【
SessionID：会话id，唯一标识
每轮的对话
摘要
全局/长期记忆
】
       达到95%上下文 触发全量摘要
       摘要：【
主请求
关键技术
文件  代码 
问题及解决
用户所有消息
提交的任务
现在的工作
下一步
】（暂定，可简单点）
3.	记忆整理
后台fork subagent，每24h或2个会话或手动
整理增量的会话记忆和长期记忆  去除过时的 假的记忆
操作指针即可  一并移除相关记忆  加锁操作
四、	工具系统
Skill Router->
Skill->
Tool Router->
【
Local：Bash，file，agent tool；
MCP:MCPServer；
HTTP：RESTAPI
】
五、	Slash
常规slash命令，压缩上下文，记忆整理，用量查询，会话查询和切换等等
六、	状态机
1.	agent
WAITING->PRE->PLANNING->EXECUTING->WAITING4->PRE
           |
          GENERATING->WAITING
2.	人格
暂定
七、	启动装配
默认加载上一次的会话，加载CANDY.md，固定以及长期记忆
八、	安全（权限）
不要在tool判断权限  可以指定模式：JST DO IT:所有的都放行；TELL ME Y:SAFE操作放行  LET ME TK:自己在设置中设置
1.	SAFE:读、查等无修改的操作 直接执行
2.	NORMAL：要授权，开应用、剪贴板或敏感数据、命令行的查和读
3.	DANGER：每次都要用户确认，可指定当前会话允许，删改、git、其他命令行等操作
4.	NOWAY：默认禁止，sudo，格式化，密码，ssh等
