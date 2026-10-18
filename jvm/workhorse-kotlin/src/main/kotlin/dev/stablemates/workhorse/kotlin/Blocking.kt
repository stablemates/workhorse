package dev.stablemates.workhorse.kotlin

import java.lang.reflect.GenericArrayType
import java.lang.reflect.ParameterizedType
import java.lang.reflect.Type
import java.lang.reflect.TypeVariable
import java.lang.reflect.WildcardType
import java.util.concurrent.Executors
import kotlin.reflect.javaType
import kotlin.reflect.typeOf
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runInterruptible

/**
 * The dispatcher of every suspend handler and every blocking call of this module. It starts one
 * virtual thread for each coroutine task, as the core does for each handler (ADR 0103,
 * "Concurrency"). Virtual threads do not keep the JVM alive, so the module never closes it.
 */
internal val VirtualThreads: CoroutineDispatcher =
  Executors.newThreadPerTaskExecutor(Thread.ofVirtual().name("workhorse-kotlin-", 0).factory())
    .asCoroutineDispatcher()

/**
 * Runs a blocking call of the core on a virtual thread. A cancellation of the caller interrupts
 * that thread. An interrupt closes the socket of a JDBC read on a virtual thread, so the connection
 * of a cancelled call is not usable after it.
 */
@PublishedApi
internal suspend fun <T> blocking(call: () -> T): T = runInterruptible(VirtualThreads, call)

/** The Java type of [T], with its type arguments, for the core's codec. */
@OptIn(ExperimentalStdlibApi::class)
@PublishedApi
internal inline fun <reified T> javaTypeOf(): Type =
  when (val type = typeOf<T>().javaType) {
    is Class<*> -> type.kotlin.javaObjectType
    else -> type
  }

/**
 * The class that [type] erases to, with a primitive class boxed. A generic array erases to the
 * array class of its erased component, so `Array<List<Long>>` gives `List[]`.
 */
@PublishedApi
internal fun erasure(type: Type): Class<*> =
  when (type) {
    is Class<*> -> type.kotlin.javaObjectType
    is ParameterizedType -> erasure(type.rawType)
    is GenericArrayType ->
      java.lang.reflect.Array.newInstance(erasure(type.genericComponentType), 0).javaClass
    is WildcardType -> erasure(type.upperBounds.first())
    is TypeVariable<*> -> erasure(type.bounds.first())
    else -> Any::class.java
  }
