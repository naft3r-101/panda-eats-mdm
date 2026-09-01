package com.pandaeats.bench

import android.app.Application
import android.content.Context
import com.pandaeats.bench.data.EnrollmentRepository
import com.pandaeats.bench.data.SecureStore
import com.pandaeats.bench.data.net.BenchApi
import com.pandaeats.bench.data.net.NetworkModule

/**
 * Manual DI container. The app is small enough (a store, a network stack, one repository)
 * that pulling Koin/Hilt in would be more machinery than the wiring it replaces.
 */
class AppContainer(context: Context) {
    val secureStore: SecureStore = SecureStore(context.applicationContext)
    private val network: NetworkModule = NetworkModule(secureStore)
    val benchApi: BenchApi = network.benchApi
    val enrollmentRepository: EnrollmentRepository = EnrollmentRepository(benchApi, secureStore)
}

class BenchApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

/** Convenience accessor from any Context. */
fun Context.appContainer(): AppContainer = (applicationContext as BenchApp).container
